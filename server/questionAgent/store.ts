/**
 * Data access and write logic for the question-fix cloud agent.
 *
 * Every production write goes through this module so the same guards apply whether a change is
 * auto-applied (safe tier) or approved by a human from Slack: format validation, stale-write
 * check, revision row (audit + revert), and unhide guards.
 */
import { hashQuestion } from "./hash";
import { pool } from "../db";
import { storage } from "../storage";
import {
  extractQuestionStem,
  questionMcqChoicesReferenceSeeImage,
  validateQuestionFormat,
} from "@shared/questionFormat";
import { detectMediaPromise, type MediaPromise } from "@shared/questionMediaHeuristics";
import { classifyQuestionFix, type FixClassification } from "@shared/questionAgentTiers";
import { isOrthoContentId, type SpecialtyId } from "@shared/specialties";
import type {
  QuestionAgentProposal,
  QuestionImageAttribution,
  QuestionRevision,
} from "@shared/schema";

export const AGENT_REVISION_SOURCE = "cloud_agent";
export const AGENT_APPROVED_REVISION_SOURCE = "cloud_agent_approved";
export const REVERT_ACTION = "revert";

export const LIMITS = {
  question: 8000,
  answer: 6000,
  rationale: 2000,
  imageAlt: 256,
  credit: 512,
};

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function agentCaps() {
  return {
    autoPerRun: intEnv("QUESTION_AGENT_MAX_AUTO_PER_RUN", 25),
    autoPerDay: intEnv("QUESTION_AGENT_MAX_AUTO_PER_DAY", 100),
    proposalsPerRun: intEnv("QUESTION_AGENT_MAX_PROPOSALS_PER_RUN", 50),
  };
}

export { hashQuestion };

export type QueueCategory = "reported" | "flagged" | "missing_media";
export const ALL_QUEUE_CATEGORIES: QueueCategory[] = ["reported", "flagged", "missing_media"];

export interface QueueItem {
  id: string;
  specialtyId: SpecialtyId;
  subsectionId: string;
  question: string;
  answer: string;
  baseHash: string;
  visible: boolean;
  flagged: boolean;
  reportedHidden: boolean;
  tags: string[];
  imageUrl: string | null;
  imageAlt: string | null;
  categories: QueueCategory[];
  mediaPromise: MediaPromise | null;
  reports: { message: string; createdAt: string }[];
  reportCount: number;
  pendingProposalId: string | null;
}

interface QuestionRow {
  id: string;
  question: string;
  answer: string;
  tags: string[] | null;
  visible: boolean;
  reported: boolean;
  flagged: boolean;
  image_url: string | null;
  image_alt: string | null;
  subsection_id: string;
  section_id: string;
  specialty_id: string | null;
}

const QUESTION_SELECT = `
  SELECT q.id, q.question, q.answer, q.tags, q.visible, q.reported, q.flagged,
         q.image_url, q.image_alt, q.subsection_id, s.id AS section_id, s.specialty_id
  FROM questions q
  JOIN subsections ss ON q.subsection_id = ss.id
  JOIN sections s ON ss.section_id = s.id
`;

function specialtyOf(row: QuestionRow): SpecialtyId {
  if (row.specialty_id === "ortho" || isOrthoContentId(row.section_id) || isOrthoContentId(row.subsection_id)) {
    return "ortho";
  }
  return "prs";
}

const OPEN_REPORT_SQL = `
  EXISTS (
    SELECT 1 FROM question_reports r
    WHERE r.question_id = q.id
      AND r.created_at > COALESCE((SELECT max(v.created_at) FROM question_revisions v WHERE v.question_id = q.id), 'epoch'::timestamp)
  )`;

async function hydrate(rows: QuestionRow[], categoriesFor: (row: QuestionRow, reportCount: number) => QueueCategory[]) {
  if (rows.length === 0) return [] as QueueItem[];
  const ids = rows.map((r) => r.id);
  const reportsRes = await pool.query(
    `SELECT r.question_id, r.message, r.created_at
       FROM question_reports r
       WHERE r.question_id = ANY($1::varchar[])
         AND r.created_at > COALESCE((SELECT max(v.created_at) FROM question_revisions v WHERE v.question_id = r.question_id), 'epoch'::timestamp)
       ORDER BY r.created_at DESC`,
    [ids]
  );
  const reportsByQ = new Map<string, { message: string; createdAt: string }[]>();
  for (const r of reportsRes.rows) {
    const list = reportsByQ.get(r.question_id) ?? [];
    list.push({ message: String(r.message).slice(0, 1000), createdAt: new Date(r.created_at).toISOString() });
    reportsByQ.set(r.question_id, list);
  }
  const pendingRes = await pool.query(
    `SELECT question_id, id FROM question_agent_proposals WHERE status = 'pending' AND question_id = ANY($1::varchar[])`,
    [ids]
  );
  const pendingByQ = new Map<string, string>(pendingRes.rows.map((r) => [r.question_id, r.id]));

  return rows.map((row): QueueItem => {
    const allReports = reportsByQ.get(row.id) ?? [];
    const mediaPromise = detectMediaPromise(row.question, !!row.image_url);
    return {
      id: row.id,
      specialtyId: specialtyOf(row),
      subsectionId: row.subsection_id,
      question: row.question,
      answer: row.answer,
      baseHash: hashQuestion(row.question, row.answer),
      visible: row.visible,
      flagged: row.flagged,
      reportedHidden: row.reported,
      tags: Array.isArray(row.tags) ? row.tags : [],
      imageUrl: row.image_url,
      imageAlt: row.image_alt,
      categories: categoriesFor(row, allReports.length),
      mediaPromise,
      reports: allReports.slice(0, 10),
      reportCount: allReports.length,
      pendingProposalId: pendingByQ.get(row.id) ?? null,
    };
  });
}

export interface QueueOptions {
  categories: QueueCategory[];
  specialtyId?: SpecialtyId;
  limit: number;
  offset: number;
  includePending: boolean;
}

export async function listQueue(opts: QueueOptions): Promise<{ items: QueueItem[]; total: number }> {
  const wanted = new Set(opts.categories);
  const clauses: string[] = [];
  if (wanted.has("reported")) clauses.push(OPEN_REPORT_SQL);
  if (wanted.has("flagged")) clauses.push("(q.flagged = true OR q.visible = false)");
  if (wanted.has("missing_media")) clauses.push("q.image_url IS NULL");
  if (clauses.length === 0) return { items: [], total: 0 };

  const res = await pool.query<QuestionRow>(`${QUESTION_SELECT} WHERE ${clauses.join(" OR ")} ORDER BY q.id`);
  const filtered = res.rows.filter((r) => !opts.specialtyId || specialtyOf(r) === opts.specialtyId);
  const items = await hydrate(filtered, (row, reportCount) => {
    const cats: QueueCategory[] = [];
    if (reportCount > 0) cats.push("reported");
    if (row.flagged || row.visible === false) cats.push("flagged");
    if (!row.image_url && detectMediaPromise(row.question, false)) cats.push("missing_media");
    return cats;
  });

  const matching = items
    .filter((it) => it.categories.some((c) => wanted.has(c)))
    .filter((it) => opts.includePending || !it.pendingProposalId)
    .sort((a, b) => {
      const rank = (it: QueueItem) => (it.categories.includes("reported") ? 0 : it.categories.includes("flagged") ? 1 : 2);
      return rank(a) - rank(b) || b.reportCount - a.reportCount || a.id.localeCompare(b.id);
    });
  return { items: matching.slice(opts.offset, opts.offset + opts.limit), total: matching.length };
}

export async function getQueueItem(id: string): Promise<QueueItem | null> {
  const res = await pool.query<QuestionRow>(`${QUESTION_SELECT} WHERE q.id = $1`, [id]);
  if (res.rows.length === 0) return null;
  const [item] = await hydrate(res.rows, (row, reportCount) => {
    const cats: QueueCategory[] = [];
    if (reportCount > 0) cats.push("reported");
    if (row.flagged || row.visible === false) cats.push("flagged");
    if (!row.image_url && detectMediaPromise(row.question, false)) cats.push("missing_media");
    return cats;
  });
  return item ?? null;
}

export async function listRevisions(questionId: string, limit = 10): Promise<QuestionRevision[]> {
  const res = await pool.query(
    `SELECT id, question_id AS "questionId", action, previous_question AS "previousQuestion",
            previous_answer AS "previousAnswer", new_question AS "newQuestion", new_answer AS "newAnswer",
            source, rationale, report_ids AS "reportIds", run_id AS "runId", created_at AS "createdAt"
       FROM question_revisions WHERE question_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [questionId, limit]
  );
  return res.rows as QuestionRevision[];
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export async function countAutoApplied(opts: { runId?: string; sinceMs?: number }): Promise<number> {
  const params: unknown[] = [AGENT_REVISION_SOURCE];
  let where = `source = $1 AND action = 'revise'`;
  if (opts.runId) {
    params.push(opts.runId);
    where += ` AND run_id = $${params.length}`;
  }
  if (opts.sinceMs) {
    params.push(new Date(Date.now() - opts.sinceMs));
    where += ` AND created_at >= $${params.length}`;
  }
  const res = await pool.query(`SELECT count(*)::int AS n FROM question_revisions WHERE ${where}`, params);
  return Number(res.rows[0]?.n ?? 0);
}

export async function countProposalsForRun(runId: string): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM question_agent_proposals WHERE run_id = $1`, [runId]);
  return Number(res.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateTextFields(question: string, answer: string, rationale?: string | null): string[] {
  const errors: string[] = [];
  if (question.length > LIMITS.question) errors.push(`question exceeds ${LIMITS.question} characters`);
  if (answer.length > LIMITS.answer) errors.push(`answer exceeds ${LIMITS.answer} characters`);
  if (rationale && rationale.length > LIMITS.rationale) errors.push(`rationale exceeds ${LIMITS.rationale} characters`);
  const fmt = validateQuestionFormat(question, answer);
  if (!fmt.valid) errors.push(...fmt.errors);
  return errors;
}

/** Reasons a question cannot go live with this text and image (mirrors PATCH /api/questions/:id guards). */
export function unhideBlockers(questionText: string, hasImage: boolean): string[] {
  const blockers: string[] = [];
  if (!hasImage && extractQuestionStem(questionText).toLowerCase().includes("radiographic")) {
    blockers.push('stem contains "radiographic" with no image attached');
  }
  if (!hasImage && questionMcqChoicesReferenceSeeImage(questionText)) {
    blockers.push('an answer choice references an image ("see image") with no image attached');
  }
  const promise = detectMediaPromise(questionText, hasImage);
  if (promise) blockers.push(`stem still promises ${promise.kind} ("${promise.match}") with nothing attached`);
  return blockers;
}

export function classify(
  existing: { question: string; answer: string },
  next: { question: string; answer: string },
  opts: { hasImageChange: boolean; wantsUnhide: boolean }
): FixClassification {
  return classifyQuestionFix({
    previousQuestion: existing.question,
    previousAnswer: existing.answer,
    nextQuestion: next.question,
    nextAnswer: next.answer,
    hasImageChange: opts.hasImageChange,
    wantsUnhide: opts.wantsUnhide,
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function applyTextChange(params: {
  questionId: string;
  previousQuestion: string;
  previousAnswer: string;
  newQuestion: string;
  newAnswer: string;
  source: string;
  rationale?: string | null;
  runId?: string | null;
}): Promise<QuestionRevision> {
  const revision = await storage.createQuestionRevision({
    questionId: params.questionId,
    action: "revise",
    previousQuestion: params.previousQuestion,
    previousAnswer: params.previousAnswer,
    newQuestion: params.newQuestion,
    newAnswer: params.newAnswer,
    source: params.source,
    rationale: params.rationale?.trim() || null,
    reportIds: [],
    runId: params.runId ?? null,
  });
  const ok = await storage.updateQuestionText(params.questionId, params.newQuestion, params.newAnswer);
  if (!ok) throw new Error("Failed to update question content.");
  return revision;
}

/** Make a hidden/flagged question visible again if guards allow. Returns blockers when refused. */
export async function unhideQuestion(questionId: string): Promise<{ ok: boolean; blockers: string[] }> {
  const q = await storage.getQuestion(questionId);
  if (!q) return { ok: false, blockers: ["question not found"] };
  const blockers = unhideBlockers(q.question, !!q.imageUrl);
  if (blockers.length > 0) return { ok: false, blockers };
  if (q.flagged) {
    const cleared = await storage.unflagQuestion(questionId);
    if (!cleared) return { ok: false, blockers: ["failed to clear the flag"] };
  }
  const shown = await storage.updateQuestionVisibility(questionId, true);
  return shown ? { ok: true, blockers: [] } : { ok: false, blockers: ["failed to set visible"] };
}

export async function revertRevision(params: {
  revisionId: string;
  runId?: string | null;
  rationale?: string | null;
}): Promise<{ ok: true; questionId: string } | { ok: false; status: number; message: string }> {
  const res = await pool.query(`SELECT * FROM question_revisions WHERE id = $1`, [params.revisionId]);
  const rev = res.rows[0];
  if (!rev) return { ok: false, status: 404, message: "Revision not found." };
  if (rev.action !== "revise" || ![AGENT_REVISION_SOURCE, AGENT_APPROVED_REVISION_SOURCE].includes(rev.source)) {
    return { ok: false, status: 403, message: "Only cloud-agent revisions can be reverted through this API." };
  }
  if (!rev.previous_question || !rev.previous_answer) {
    return { ok: false, status: 409, message: "Revision has no previous text to restore." };
  }
  const q = await storage.getQuestion(rev.question_id);
  if (!q) return { ok: false, status: 404, message: "Question not found." };
  if (q.question !== rev.new_question || q.answer !== rev.new_answer) {
    return {
      ok: false,
      status: 409,
      message: "Question has changed since this revision; refusing to overwrite newer edits.",
    };
  }
  await storage.createQuestionRevision({
    questionId: rev.question_id,
    action: REVERT_ACTION,
    previousQuestion: q.question,
    previousAnswer: q.answer,
    newQuestion: rev.previous_question,
    newAnswer: rev.previous_answer,
    source: "cloud_agent_revert",
    rationale: params.rationale?.trim() || `Revert of revision ${params.revisionId}`,
    reportIds: [],
    runId: params.runId ?? null,
  });
  const ok = await storage.updateQuestionText(rev.question_id, rev.previous_question, rev.previous_answer);
  if (!ok) return { ok: false, status: 500, message: "Failed to restore question text." };
  return { ok: true, questionId: rev.question_id };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

function rowToProposal(r: any): QuestionAgentProposal {
  return {
    id: r.id,
    questionId: r.question_id,
    status: r.status,
    baseHash: r.base_hash,
    previousQuestion: r.previous_question,
    previousAnswer: r.previous_answer,
    newQuestion: r.new_question,
    newAnswer: r.new_answer,
    imageUrl: r.image_url,
    imageAlt: r.image_alt,
    imageAttribution: r.image_attribution ?? null,
    unhide: r.unhide,
    rationale: r.rationale,
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    runId: r.run_id,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export interface NewProposal {
  questionId: string;
  baseHash: string;
  previousQuestion: string;
  previousAnswer: string;
  newQuestion: string | null;
  newAnswer: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  imageAttribution: QuestionImageAttribution | null;
  unhide: boolean;
  rationale: string | null;
  reasons: string[];
  runId: string | null;
}

export async function createProposal(p: NewProposal): Promise<QuestionAgentProposal> {
  await pool.query(
    `UPDATE question_agent_proposals SET status = 'superseded', decided_at = now(), decided_by = 'system'
       WHERE question_id = $1 AND status = 'pending'`,
    [p.questionId]
  );
  const res = await pool.query(
    `INSERT INTO question_agent_proposals
       (question_id, base_hash, previous_question, previous_answer, new_question, new_answer,
        image_url, image_alt, image_attribution, unhide, rationale, reasons, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13)
     RETURNING *`,
    [
      p.questionId,
      p.baseHash,
      p.previousQuestion,
      p.previousAnswer,
      p.newQuestion,
      p.newAnswer,
      p.imageUrl,
      p.imageAlt,
      p.imageAttribution ? JSON.stringify(p.imageAttribution) : null,
      p.unhide,
      p.rationale,
      JSON.stringify(p.reasons),
      p.runId,
    ]
  );
  return rowToProposal(res.rows[0]);
}

export async function getProposal(id: string): Promise<QuestionAgentProposal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query(`SELECT * FROM question_agent_proposals WHERE id = $1`, [id]);
  return res.rows[0] ? rowToProposal(res.rows[0]) : null;
}

export async function listProposals(filter: {
  status?: string;
  runId?: string;
  questionId?: string;
  limit: number;
}): Promise<QuestionAgentProposal[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.runId) {
    params.push(filter.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (filter.questionId) {
    params.push(filter.questionId);
    where.push(`question_id = $${params.length}`);
  }
  params.push(filter.limit);
  const res = await pool.query(
    `SELECT * FROM question_agent_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.rows.map(rowToProposal);
}

export type DecisionResult =
  | { ok: true; status: "approved" | "rejected"; unhide?: { ok: boolean; blockers: string[] } }
  | { ok: false; httpStatus: number; message: string };

/** Approve: apply through the same guarded path as auto fixes. */
export async function approveProposal(id: string, decidedBy: string, note?: string | null): Promise<DecisionResult> {
  const proposal = await getProposal(id);
  if (!proposal) return { ok: false, httpStatus: 404, message: "Proposal not found." };
  if (proposal.status !== "pending") {
    return { ok: false, httpStatus: 409, message: `Proposal is already ${proposal.status}.` };
  }
  const q = await storage.getQuestion(proposal.questionId);
  if (!q) return { ok: false, httpStatus: 404, message: "Question no longer exists." };

  if (hashQuestion(q.question, q.answer) !== proposal.baseHash) {
    await markProposal(id, "stale", decidedBy, "Question text changed after the proposal was filed.");
    return {
      ok: false,
      httpStatus: 409,
      message: "The question was edited after this proposal was filed, so it is now stale. Ask the agent to redo it.",
    };
  }

  if (proposal.newQuestion != null && proposal.newAnswer != null) {
    const errors = validateTextFields(proposal.newQuestion, proposal.newAnswer);
    if (errors.length > 0) {
      return { ok: false, httpStatus: 400, message: `Proposed text failed validation: ${errors.join("; ")}` };
    }
    await applyTextChange({
      questionId: proposal.questionId,
      previousQuestion: q.question,
      previousAnswer: q.answer,
      newQuestion: proposal.newQuestion,
      newAnswer: proposal.newAnswer,
      source: AGENT_APPROVED_REVISION_SOURCE,
      rationale: proposal.rationale,
      runId: proposal.runId,
    });
  }

  if (proposal.imageUrl) {
    const ok = await storage.updateQuestionImage(
      proposal.questionId,
      proposal.imageUrl,
      proposal.imageAlt,
      proposal.imageAttribution ?? null
    );
    if (!ok) return { ok: false, httpStatus: 500, message: "Failed to attach the image." };
  }

  let unhide: { ok: boolean; blockers: string[] } | undefined;
  if (proposal.unhide) unhide = await unhideQuestion(proposal.questionId);

  await markProposal(id, "approved", decidedBy, note ?? null);
  return { ok: true, status: "approved", unhide };
}

export async function rejectProposal(id: string, decidedBy: string, note?: string | null): Promise<DecisionResult> {
  const proposal = await getProposal(id);
  if (!proposal) return { ok: false, httpStatus: 404, message: "Proposal not found." };
  if (proposal.status !== "pending") {
    return { ok: false, httpStatus: 409, message: `Proposal is already ${proposal.status}.` };
  }
  await markProposal(id, "rejected", decidedBy, note ?? null);
  return { ok: true, status: "rejected" };
}

async function markProposal(id: string, status: string, decidedBy: string, note: string | null): Promise<void> {
  await pool.query(
    `UPDATE question_agent_proposals SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1`,
    [id, status, decidedBy, note]
  );
}
