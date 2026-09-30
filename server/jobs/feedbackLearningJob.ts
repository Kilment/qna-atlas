/**
 * Weekly agent: cluster learner reports / contact / miss rates, revise live questions
 * with Claude Opus 5, or hide items that need images/photos for a human fix.
 *
 *   npm run feedback-agent
 *   FEEDBACK_AGENT_ENABLED=true  (hourly tick; runs when 7d watermark elapsed)
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { validateQuestionFormat, contentRulesForGenerated } from "@shared/questionFormat";
import { postSlackNotification } from "../notifySupport";
import {
  formatMemoryBlock,
  lessonFingerprint,
  parseLessonDrafts,
  revisionFinetuneMessages,
} from "./agentMemory";
import {
  extractQuestionIdsFromText,
  parseAgentDecision,
  rankCandidates,
  truncateForSlack,
  MIN_REPORTS,
  type AgentDecision,
  type RankedCandidate,
} from "./feedbackLearningLogic";
import { resolveClaudeModel } from "../claudeModels";

export const FEEDBACK_AGENT_JOB_NAME = "feedback_learning";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_UPDATES = 15;
const DEFAULT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are the Atlas Review content revision agent for surgical board-exam MCQs (plastic surgery and orthopaedics).
You receive one live question (stem + choices + explanation) and clustered learner feedback.

Decide exactly one action:
- "revise": the stem, choices, keyed letter, or explanation can be fixed in text (typo, wrong key with clear evidence, outdated fact, contradictory explanation, formatting). Provide full revisedQuestion and revisedAnswer. Keep board-level difficulty; do not dumb down a hard but valid item. Never invent a new correct letter unless feedback clearly shows the current key is wrong. Never use the word "radiographic". Do not add "see image" choices.
- "needs_manual": the item cannot be fixed in text alone — missing imaging, photo, figure, video, exhibit, or the vignette is unusable without that asset. Do not invent placeholder images or rewrite as if the media existed. Note: operators can attach images via the attach:question-image CLI; prefer needs_manual only when no image asset exists yet.
- "skip": vague, conflicting, or "this is just hard" with no clear defect. Performance/miss rate alone is not enough without a textual defect.

Return JSON only (no markdown):
{"action":"revise"|"needs_manual"|"skip","reason":"short","confidence":"high"|"medium"|"low","revisedQuestion":"...","revisedAnswer":"..."}
revisedQuestion/revisedAnswer required only for revise.`;

export type FeedbackAgentResult = {
  skippedPeriod: boolean;
  model: string;
  candidates: number;
  revised: number;
  needsManual: number;
  skipped: number;
  errors: string[];
  digestPosted: boolean;
  lessonsAdded: number;
  finetuneExamples: number;
};

function modelId(): string {
  return resolveClaudeModel(process.env.FEEDBACK_AGENT_MODEL, DEFAULT_MODEL);
}

function maxUpdates(): number {
  const n = Number(process.env.FEEDBACK_AGENT_MAX_UPDATES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPDATES;
}

export function feedbackAgentPeriodMs(): number {
  const n = Number(process.env.FEEDBACK_AGENT_PERIOD_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PERIOD_MS;
}

export function feedbackAgentTickMs(): number {
  const n = Number(process.env.FEEDBACK_AGENT_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICK_MS;
}

export async function isFeedbackAgentDue(now = Date.now()): Promise<boolean> {
  const last = await storage.getLastSuccessfulAgentJobRun(FEEDBACK_AGENT_JOB_NAME);
  if (!last?.finishedAt && !last?.startedAt) {
    return process.env.FEEDBACK_AGENT_RUN_ON_START === "true";
  }
  const t = (last.finishedAt ?? last.startedAt).getTime();
  return now - t >= feedbackAgentPeriodMs();
}

function textFromClaude(response: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

async function decideWithOpus(params: {
  questionId: string;
  question: string;
  answer: string;
  reports: string[];
  missNote: string;
  system: string;
}): Promise<{ decision: AgentDecision; userPayload: string; assistantPayload: string | null }> {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  const userPayload = JSON.stringify({
    questionId: params.questionId,
    question: params.question.slice(0, 6000),
    answer: params.answer.slice(0, 4000),
    reports: params.reports.slice(0, 20),
    performance: params.missNote,
  });
  if (!apiKey) {
    return {
      decision: { action: "skip", reason: "CLAUDE_API_KEY is not set" },
      userPayload,
      assistantPayload: null,
    };
  }
  const client = new Anthropic({ apiKey });

  const create = (extra: Record<string, unknown> = {}) =>
    client.messages.create({
      model: modelId(),
      max_tokens: 8000,
      system: params.system,
      messages: [{ role: "user", content: userPayload }],
      ...extra,
    } as Anthropic.MessageCreateParams);

  let response: Anthropic.Message;
  try {
    response = await create({ output_config: { effort: "high" } });
  } catch {
    response = await create();
  }

  const raw = textFromClaude(response);
  const parsed = parseAgentDecision(raw);
  if (!parsed) {
    return {
      decision: { action: "skip", reason: "Could not parse Opus 5 JSON" },
      userPayload,
      assistantPayload: null,
    };
  }
  return { decision: parsed, userPayload, assistantPayload: JSON.stringify(parsed) };
}

function buildDigest(params: {
  model: string;
  revised: { id: string; reason: string; before: string; after: string }[];
  needsManual: { id: string; reason: string }[];
  skipped: { id: string; reason: string }[];
  errors: string[];
  candidates: number;
  lessonsAdded: number;
}): string {
  const lines = [
    `*Weekly feedback agent* (\`${params.model}\`)`,
    `Candidates: ${params.candidates} · Revised: ${params.revised.length} · Hidden for manual fix: ${params.needsManual.length} · Skipped: ${params.skipped.length} · New memory lessons: ${params.lessonsAdded}`,
  ];
  if (params.needsManual.length) {
    lines.push("");
    lines.push("*Needs manual revision (hidden until unflagged)*");
    for (const item of params.needsManual.slice(0, 25)) {
      lines.push(`• \`${item.id}\` — ${truncateForSlack(item.reason, 200)}`);
    }
  }
  if (params.revised.length) {
    lines.push("");
    lines.push("*Applied live revisions*");
    for (const item of params.revised.slice(0, 15)) {
      lines.push(`• \`${item.id}\` — ${truncateForSlack(item.reason, 160)}`);
      lines.push(`  Before: ${truncateForSlack(item.before, 180)}`);
      lines.push(`  After: ${truncateForSlack(item.after, 180)}`);
    }
  }
  if (params.skipped.length) {
    lines.push("");
    lines.push("*Skipped*");
    for (const item of params.skipped.slice(0, 15)) {
      lines.push(`• \`${item.id}\` — ${truncateForSlack(item.reason, 160)}`);
    }
  }
  if (params.errors.length) {
    lines.push("");
    lines.push("*Errors*");
    for (const e of params.errors.slice(0, 10)) {
      lines.push(`• ${truncateForSlack(e, 200)}`);
    }
  }
  return lines.join("\n");
}

async function backfillFinetuneFromRevisions(system: string): Promise<number> {
  const existing = await storage.listFinetuneExamples("revision", 1);
  if (existing.length > 0) return 0;
  const revs = await storage.listRecentRevisions(200);
  let n = 0;
  for (const rev of revs) {
    if (rev.action !== "revise" && rev.action !== "needs_manual") continue;
    const assistant =
      rev.action === "revise"
        ? JSON.stringify({
            action: "revise",
            reason: rev.rationale ?? "",
            revisedQuestion: rev.newQuestion ?? "",
            revisedAnswer: rev.newAnswer ?? "",
          })
        : JSON.stringify({ action: "needs_manual", reason: rev.rationale ?? "" });
    const user = JSON.stringify({
      questionId: rev.questionId,
      question: (rev.previousQuestion ?? "").slice(0, 6000),
      answer: (rev.previousAnswer ?? "").slice(0, 4000),
      source: "backfill",
    });
    await storage.createFinetuneExample({
      kind: "revision",
      messages: revisionFinetuneMessages({ system, user, assistant }),
      metadata: { questionId: rev.questionId, action: rev.action, source: "backfill", revisionId: rev.id },
    });
    n += 1;
  }
  return n;
}

async function distillLessonsFromRun(params: {
  system: string;
  revised: { id: string; reason: string }[];
  needsManual: { id: string; reason: string }[];
  skipped: { id: string; reason: string }[];
  runId: string;
}): Promise<number> {
  const existing = await storage.listActiveAgentLessons(40);
  const hasNewOutcomes =
    params.revised.length + params.needsManual.length + params.skipped.length > 0;
  let outcomes = {
    revised: params.revised.slice(0, 40).map((r) => ({ id: r.id, reason: r.reason })),
    needsManual: params.needsManual.slice(0, 40).map((r) => ({ id: r.id, reason: r.reason })),
    skipped: params.skipped.slice(0, 20).map((r) => ({ id: r.id, reason: r.reason })),
  };
  if (!hasNewOutcomes && existing.length === 0) {
    const revs = await storage.listRecentRevisions(80);
    if (revs.length === 0) return 0;
    outcomes = {
      revised: revs
        .filter((r) => r.action === "revise")
        .map((r) => ({ id: r.questionId, reason: r.rationale ?? "revised" })),
      needsManual: revs
        .filter((r) => r.action === "needs_manual")
        .map((r) => ({ id: r.questionId, reason: r.rationale ?? "needs manual" })),
      skipped: [],
    };
  } else if (!hasNewOutcomes) {
    return 0;
  }

  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  if (!apiKey) return 0;
  const client = new Anthropic({ apiKey });
  const user = JSON.stringify({
    existingLessons: existing.map((l) => ({ category: l.category, lesson: l.lesson })),
    thisRun: outcomes,
  });
  const distillSystem = `You distill durable editorial rules for Atlas Review MCQ generation and revision.
Given this week's outcomes and existing lessons, return ONLY new, generalizable rules (not item-specific IDs).
Categories: media, keying, explanation, format, distractors, difficulty, generation_avoid.
JSON array only: [{"category":"...","lesson":"..."}]
If nothing new, return []. Max 8 lessons. Each lesson one sentence.`;

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: modelId(),
      max_tokens: 2000,
      system: distillSystem,
      messages: [{ role: "user", content: user }],
    });
  } catch {
    return 0;
  }
  const drafts = parseLessonDrafts(textFromClaude(response));
  let added = 0;
  for (const d of drafts) {
    const ok = await storage.insertAgentLessonIfNew({
      category: d.category,
      lesson: d.lesson,
      fingerprint: lessonFingerprint(d.lesson),
      source: "feedback_agent",
      evidence: { runId: params.runId },
      active: true,
    });
    if (ok) added += 1;
  }
  return added;
}

export async function runFeedbackLearningJob(opts: { force?: boolean } = {}): Promise<FeedbackAgentResult> {
  const model = modelId();
  const empty: FeedbackAgentResult = {
    skippedPeriod: false,
    model,
    candidates: 0,
    revised: 0,
    needsManual: 0,
    skipped: 0,
    errors: [],
    digestPosted: false,
    lessonsAdded: 0,
    finetuneExamples: 0,
  };

  if (!opts.force && !(await isFeedbackAgentDue())) {
    return { ...empty, skippedPeriod: true };
  }

  const run = await storage.startAgentJobRun(FEEDBACK_AGENT_JOB_NAME);
  const allHistory = process.env.FEEDBACK_AGENT_ALL_HISTORY === "true";
  const period = feedbackAgentPeriodMs();
  const since = allHistory ? new Date(0) : new Date(Date.now() - period);
  const errors: string[] = [];

  try {
    const [reports, contacts, missRates] = await Promise.all([
      storage.getQuestionReportsSince(since),
      storage.getContactMessagesSince(since),
      storage.getMissRatesSince(since),
    ]);

    const reportQuestionIds = new Set(reports.map((r) => r.questionId));
    const contactQuestionIds: string[] = [];
    for (const c of contacts) {
      const blob = `${c.subject}\n${c.message}`;
      contactQuestionIds.push(...extractQuestionIdsFromText(blob, reportQuestionIds));
    }

    const lastRev = await storage.getLatestRevisionTimes([
      ...new Set([...reports.map((r) => r.questionId), ...contactQuestionIds]),
    ]);

    const candidates = rankCandidates({
      reports: reports.map((r) => ({
        id: r.id,
        questionId: r.questionId,
        message: r.message,
        createdAt: r.createdAt,
      })),
      missRates,
      contactQuestionIds,
      lastRevisionAtByQuestionId: lastRev,
      minReports: allHistory ? 1 : MIN_REPORTS,
    });

    const lessonRows = await storage.listActiveAgentLessons(40);
    const memoryBlock = formatMemoryBlock(lessonRows);
    const system = memoryBlock ? `${SYSTEM_PROMPT}\n\n${memoryBlock}` : SYSTEM_PROMPT;
    let finetuneExamples = await backfillFinetuneFromRevisions(system);

    const revised: { id: string; reason: string; before: string; after: string }[] = [];
    const needsManual: { id: string; reason: string }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    let reviseCount = 0;

    for (const cand of candidates) {
      try {
        await processCandidate(cand, {
          runId: run.id,
          maxUpdates: maxUpdates(),
          reviseCount,
          revised,
          needsManual,
          skipped,
          system,
          onFinetune: () => {
            finetuneExamples += 1;
          },
          bumpRevise: () => {
            reviseCount += 1;
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${cand.questionId}: ${msg}`);
      }
    }

    const lessonsAdded = await distillLessonsFromRun({
      system,
      revised,
      needsManual,
      skipped,
      runId: run.id,
    });

    const digestPosted = await postSlackNotification(
      "question-report",
      buildDigest({
        model,
        revised,
        needsManual,
        skipped,
        errors,
        candidates: candidates.length,
        lessonsAdded,
      })
    );

    const stats = {
      model,
      candidates: candidates.length,
      revised: revised.length,
      needsManual: needsManual.length,
      skipped: skipped.length,
      lessonsAdded,
      finetuneExamples,
      errors,
    };
    await storage.finishAgentJobRun(run.id, "success", stats);
    return {
      skippedPeriod: false,
      model,
      candidates: candidates.length,
      revised: revised.length,
      needsManual: needsManual.length,
      skipped: skipped.length,
      errors,
      digestPosted,
      lessonsAdded,
      finetuneExamples,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    await storage.finishAgentJobRun(run.id, "error", { errors });
    throw e;
  }
}

async function processCandidate(
  cand: RankedCandidate,
  ctx: {
    runId: string;
    maxUpdates: number;
    reviseCount: number;
    revised: { id: string; reason: string; before: string; after: string }[];
    needsManual: { id: string; reason: string }[];
    skipped: { id: string; reason: string }[];
    system: string;
    onFinetune: () => void;
    bumpRevise: () => void;
  }
): Promise<void> {
  const q = await storage.getQuestion(cand.questionId);
  if (!q) {
    ctx.skipped.push({ id: cand.questionId, reason: "Question not found" });
    return;
  }

  const missNote =
    cand.missRate == null
      ? "no recent performance sample"
      : `recent miss rate ${(cand.missRate * 100).toFixed(0)}% over ${cand.answered} answers; rank reasons: ${cand.reasons.join(", ")}`;

  const { decision, userPayload, assistantPayload } = await decideWithOpus({
    questionId: cand.questionId,
    question: q.question,
    answer: q.answer,
    reports: cand.reports.map((r) => r.message),
    missNote,
    system: ctx.system,
  });

  if (decision.action === "needs_manual") {
    await storage.flagQuestion(cand.questionId, "needs-manual-revision");
    await storage.createQuestionRevision({
      questionId: cand.questionId,
      action: "needs_manual",
      previousQuestion: q.question,
      previousAnswer: q.answer,
      source: "feedback_agent",
      rationale: decision.reason,
      reportIds: cand.reports.map((r) => r.id),
      runId: ctx.runId,
    });
    ctx.needsManual.push({ id: cand.questionId, reason: decision.reason });
    if (assistantPayload) {
      await storage.createFinetuneExample({
        kind: "revision",
        messages: revisionFinetuneMessages({
          system: ctx.system,
          user: userPayload,
          assistant: assistantPayload,
        }),
        metadata: { questionId: cand.questionId, action: "needs_manual", runId: ctx.runId },
      });
      ctx.onFinetune();
    }
    return;
  }

  if (decision.action !== "revise") {
    ctx.skipped.push({ id: cand.questionId, reason: decision.reason || "skip" });
    return;
  }

  if (ctx.reviseCount >= ctx.maxUpdates) {
    ctx.skipped.push({ id: cand.questionId, reason: "Weekly revise cap reached; left for next run" });
    return;
  }

  const newQ = decision.revisedQuestion?.trim() ?? "";
  const newA = decision.revisedAnswer?.trim() ?? "";
  if (!newQ || !newA) {
    ctx.skipped.push({ id: cand.questionId, reason: "revise missing stem or answer" });
    return;
  }
  const fmt = validateQuestionFormat(newQ, newA);
  if (!fmt.valid) {
    ctx.skipped.push({
      id: cand.questionId,
      reason: `format failed: ${fmt.errors.join("; ") || "invalid"}`,
    });
    return;
  }
  if (q.source === "generated") {
    const rules = contentRulesForGenerated(newQ);
    if (!rules.pass) {
      ctx.skipped.push({ id: cand.questionId, reason: `content rules: ${rules.reason ?? "failed"}` });
      return;
    }
  }

  await storage.createQuestionRevision({
    questionId: cand.questionId,
    action: "revise",
    previousQuestion: q.question,
    previousAnswer: q.answer,
    newQuestion: newQ,
    newAnswer: newA,
    source: "feedback_agent",
    rationale: decision.reason,
    reportIds: cand.reports.map((r) => r.id),
    runId: ctx.runId,
  });
  const ok = await storage.updateQuestionText(cand.questionId, newQ, newA);
  if (!ok) {
    ctx.skipped.push({ id: cand.questionId, reason: "DB update failed" });
    return;
  }
  ctx.bumpRevise();
  ctx.revised.push({
    id: cand.questionId,
    reason: decision.reason,
    before: q.question,
    after: newQ,
  });
  if (assistantPayload) {
    await storage.createFinetuneExample({
      kind: "revision",
      messages: revisionFinetuneMessages({
        system: ctx.system,
        user: userPayload,
        assistant: assistantPayload,
      }),
      metadata: { questionId: cand.questionId, action: "revise", runId: ctx.runId },
    });
    ctx.onFinetune();
  }
}

export async function seedAgentMemoryFromHistory(): Promise<{ lessonsAdded: number; finetuneExamples: number }> {
  const system = SYSTEM_PROMPT;
  const finetuneExamples = await backfillFinetuneFromRevisions(system);
  const lessonsAdded = await distillLessonsFromRun({
    system,
    revised: [],
    needsManual: [],
    skipped: [],
    runId: "seed",
  });
  return { lessonsAdded, finetuneExamples };
}

if (process.argv[1]?.includes("feedbackLearningJob")) {
  runFeedbackLearningJob({ force: true })
    .then((r) => console.log("Done:", r))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
