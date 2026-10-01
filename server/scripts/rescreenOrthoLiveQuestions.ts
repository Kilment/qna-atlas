/**
 * Strict rescreen of all *live* Ortho questions (visible + unflagged).
 *
 * Checks:
 *  1) Keyed answer letter is medically correct for the stem
 *  2) Explanation matches the stem and keyed answer (no contradictions)
 *  3) Explanation includes why EACH wrong option is wrong (PRS Atlas style:
 *     "A is incorrect because... B is incorrect because...")
 *
 * High-confidence fixes are auto-applied. Uncertain items are flagged+hidden.
 * Prefers Claude (Opus) when CLAUDE_API_KEY is set; falls back to OpenAI.
 *
 *   npm run rescreen:ortho-live
 *   ORTHO_RESCREEN_MODEL=claude-opus-5-5
 *   ORTHO_RESCREEN_BATCH=2 ORTHO_RESCREEN_CONCURRENCY=2
 *   ORTHO_RESCREEN_LIMIT=50  # optional sample
 */
import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { questions } from "@shared/schema";
import { validateQuestionFormat } from "@shared/questionFormat";
import { CLAUDE_OPUS, claudeRejectsSamplingParams, resolveClaudeModel } from "../claudeModels";
import { cachedSystem } from "../claudePromptCache";

const OUT_DIR = path.join(process.cwd(), "server", "data");
const FLAG_PATH = path.join(OUT_DIR, "orthoRescreenFlags.json");
const SUMMARY_PATH = path.join(OUT_DIR, "orthoRescreenSummary.json");
const PROGRESS_PATH = path.join(OUT_DIR, "orthoRescreenProgress.json");

const LIMIT = process.env.ORTHO_RESCREEN_LIMIT
  ? parseInt(process.env.ORTHO_RESCREEN_LIMIT, 10)
  : Infinity;
const BATCH = Math.min(3, Math.max(1, parseInt(process.env.ORTHO_RESCREEN_BATCH || "2", 10) || 2));
const CONCURRENCY = Math.min(
  4,
  Math.max(1, parseInt(process.env.ORTHO_RESCREEN_CONCURRENCY || "2", 10) || 2)
);
const DEFAULT_CLAUDE_MODEL = CLAUDE_OPUS;
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const MODEL =
  process.env.ORTHO_RESCREEN_MODEL ||
  (process.env.CLAUDE_API_KEY ? DEFAULT_CLAUDE_MODEL : DEFAULT_OPENAI_MODEL);

function resolvedModel(provider: LLMClient["provider"]): string {
  return provider === "claude" ? resolveClaudeModel(MODEL, DEFAULT_CLAUDE_MODEL) : MODEL;
}

type LLMClient =
  | { provider: "claude"; client: Anthropic }
  | { provider: "openai"; client: OpenAI };

type Verdict = "ok" | "fix" | "flag";
type Confidence = "high" | "medium" | "low";

type ReviewItem = {
  id: string;
  verdict: Verdict;
  confidence: Confidence;
  issue?: string;
  problems?: string[];
  correctedQuestion?: string;
  correctedAnswer?: string;
};

type FlagRecord = {
  id: string;
  subsectionId: string;
  confidence: Confidence;
  issue: string;
  problems?: string[];
  questionPreview: string;
  answerPreview: string;
  suggestedQuestion?: string;
  suggestedAnswer?: string;
  reviewedAt: string;
};

function getLLM(): LLMClient {
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (claudeKey) return { provider: "claude", client: new Anthropic({ apiKey: claudeKey }) };
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_QUESTION_GENERATION_API_KEY;
  if (openaiKey) return { provider: "openai", client: new OpenAI({ apiKey: openaiKey }) };
  throw new Error("Missing CLAUDE_API_KEY or OPENAI_API_KEY");
}

/** Heuristic: PRS-style distractor coverage present? */
export function hasDistractorRationales(answer: string, choiceLetters: string[]): boolean {
  const a = answer.toLowerCase();
  const wrong = choiceLetters.filter((L) => {
    const lead = answer.trim().match(/^([A-F])\)/i)?.[1]?.toUpperCase();
    return L !== lead;
  });
  if (wrong.length === 0) return true;
  let covered = 0;
  for (const L of wrong) {
    const re = new RegExp(
      `(?:^|[\\s.])${L}\\s*(?:\\)|is incorrect|is wrong|is not|would be incorrect|incorrect because)`,
      "i"
    );
    const re2 = new RegExp(`option\\s+${L}\\s+is incorrect`, "i");
    if (re.test(answer) || re2.test(answer) || a.includes(`${L.toLowerCase()} is incorrect`)) {
      covered++;
    }
  }
  // Require rationale for at least most distractors (all if ≤3 wrong, else ≥n-1)
  const need = wrong.length <= 3 ? wrong.length : wrong.length - 1;
  return covered >= need;
}

export function choiceLettersFromQuestion(question: string): string[] {
  const letters: string[] = [];
  for (const line of question.split("\n")) {
    const m = line.match(/^([A-F])\)\s+\S/);
    if (m) letters.push(m[1].toUpperCase());
  }
  return letters;
}

function alreadyRescreened(row: { answer: string; question: string; tags: string[] | null }): boolean {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  if (!tags.includes("rescreen-auto-fixed") && !tags.includes("rescreen-letter-changed")) return false;
  return hasDistractorRationales(row.answer, choiceLettersFromQuestion(row.question));
}

function buildSystemPrompt(): string {
  return `You are a strict orthopaedic board-exam content auditor for Ortho Atlas.
Your prior pass MISSED clear errors (example failures to avoid repeating):
- Cubital tunnel after failed conservative care keyed to "ulnar nerve transposition" when in-situ open release was the appropriate first-line surgical choice.
- A stem describing inability to actively EXTEND the fingertip after trauma keyed to jersey finger (FDP) instead of mallet finger (terminal extensor), and/or an explanation that contradicted the keyed letter.

For EACH item you must verify ALL of:
1) Medical correctness: the keyed answer letter is the best OITE/board answer for THIS stem.
2) Consistency: the explanation supports that letter and does not contradict the stem findings.
3) Distractor teaching (PRS Atlas style): after explaining why the correct choice is right, briefly state why EACH wrong option is wrong, e.g. "A is incorrect because... C is incorrect because...".

Verdicts:
- "ok": letter correct AND explanation consistent AND every wrong option has a why-wrong rationale.
- "fix": anything fails above. Provide correctedAnswer ALWAYS (full text starting with "X)\\n..."). Include correctedQuestion only if stem/choices must change.
  Use confidence "high" when the letter change or explanation rewrite is clear.
  Use "medium"/"low" when debated; prefer "flag" if you would not bet on the rewrite.
- "flag": ambiguous / controversy / insufficient info — do NOT invent a fix. Explain the issue.

When rewriting explanations, keep board-level accuracy, be concise, and use this shape:
  X)
  <2–4 sentences why X is correct given the stem.>
  A is incorrect because... B is incorrect because... (skip the correct letter).

Never use the word "radiographic" in a corrected stem.
If missingDistractorRationales is true, verdict cannot be "ok" unless you verify rationales are already present — otherwise fix the explanation.
Output: JSON array only, no markdown fences. Each object:
{ "id", "verdict", "confidence", "issue?", "problems?": string[], "correctedQuestion?", "correctedAnswer?" }
Shape example (format only):
{"id":"example","verdict":"fix","confidence":"high","issue":"explanation contradicts the keyed letter","problems":["contradiction","missing distractor rationale"],"correctedAnswer":"C)\nC is correct because the stem findings match C.\nA is incorrect because it names a different structure.\nB is incorrect because it is the operation for a diagnosis this stem does not describe.\nD is incorrect because the exam finding rules it out."}`;
}

function parseReviews(raw: string): ReviewItem[] {
  let text = raw.trim();
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();
  const parsed = JSON.parse(text) as unknown;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ReviewItem[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as any).id ?? "").trim();
    const verdict = String((item as any).verdict ?? "").toLowerCase() as Verdict;
    const confidence = String((item as any).confidence ?? "low").toLowerCase() as Confidence;
    if (!id || !["ok", "fix", "flag"].includes(verdict)) continue;
    out.push({
      id,
      verdict,
      confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "low",
      issue: typeof (item as any).issue === "string" ? (item as any).issue : undefined,
      problems: Array.isArray((item as any).problems)
        ? (item as any).problems.filter((p: unknown): p is string => typeof p === "string")
        : undefined,
      correctedQuestion:
        typeof (item as any).correctedQuestion === "string"
          ? (item as any).correctedQuestion
          : undefined,
      correctedAnswer:
        typeof (item as any).correctedAnswer === "string" ? (item as any).correctedAnswer : undefined,
    });
  }
  return out;
}

function extractAnswerLetter(answer: string): string | null {
  return answer.trim().match(/^([A-F])\)/i)?.[1]?.toUpperCase() ?? null;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function reviewBatch(
  llm: LLMClient,
  batch: { id: string; question: string; answer: string }[]
): Promise<ReviewItem[]> {
  const payload = batch.map((b) => ({
    id: b.id,
    question: b.question.slice(0, 3800),
    answer: b.answer.slice(0, 2200),
    missingDistractorRationales: !hasDistractorRationales(
      b.answer,
      choiceLettersFromQuestion(b.question)
    ),
  }));
  const userContent = `Strictly rescreen these ${payload.length} live Ortho Atlas MCQs.\n${JSON.stringify(payload)}`;

  let content: string | null = null;
  if (llm.provider === "claude") {
    const model = resolvedModel(llm.provider);
    const response = await llm.client.messages.create({
      model,
      max_tokens: 8000,
      ...(claudeRejectsSamplingParams(model) ? {} : { temperature: 0.15 }),
      system: cachedSystem(buildSystemPrompt()),
      messages: [{ role: "user", content: userContent }],
    });
    const block = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
    content = block?.text ?? null;
  } else {
    const response = await llm.client.chat.completions.create({
      model: resolvedModel(llm.provider),
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userContent },
      ],
      temperature: 0.15,
      max_tokens: 5000,
    });
    content = response.choices?.[0]?.message?.content ?? null;
  }

  if (!content) {
    return batch.map((b) => ({
      id: b.id,
      verdict: "flag" as const,
      confidence: "low" as const,
      issue: "Empty model response",
    }));
  }
  try {
    return parseReviews(content);
  } catch (e) {
    console.error("parse fail", e);
    return batch.map((b) => ({
      id: b.id,
      verdict: "flag" as const,
      confidence: "low" as const,
      issue: "Failed to parse auditor JSON",
    }));
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const llm = getLLM();
  console.log(`Using ${llm.provider} model=${resolvedModel(llm.provider)}`);

  let rows = await db
    .select({
      id: questions.id,
      question: questions.question,
      answer: questions.answer,
      subsectionId: questions.subsectionId,
      source: questions.source,
      tags: questions.tags,
    })
    .from(questions)
    .where(
      and(like(questions.id, "ortho-%"), eq(questions.visible, true), eq(questions.flagged, false))
    );

  if (Number.isFinite(LIMIT)) rows = rows.slice(0, LIMIT);

  const needingUpgrade = rows.filter(
    (r) => !hasDistractorRationales(r.answer, choiceLettersFromQuestion(r.question))
  ).length;
  const priorDone = rows.filter((r) => alreadyRescreened(r));
  const priorDoneIds = new Set(priorDone.map((r) => r.id));
  const todo = rows.filter((r) => !priorDoneIds.has(r.id));

  // Preserve flags from prior interrupted runs
  let flags: FlagRecord[] = [];
  if (fs.existsSync(FLAG_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(FLAG_PATH, "utf8")) as { flags?: FlagRecord[] };
      if (Array.isArray(prev.flags)) flags = prev.flags;
    } catch {
      /* ignore */
    }
  }
  const flagIds = new Set(flags.map((f) => f.id));

  console.log(
    JSON.stringify({
      live: rows.length,
      alreadyRescreenedSkipped: priorDone.length,
      remaining: todo.length,
      needingDistractorUpgradeHeuristic: needingUpgrade,
      priorFlagsKept: flags.length,
      batch: BATCH,
      concurrency: CONCURRENCY,
      provider: llm.provider,
      model: resolvedModel(llm.provider),
    })
  );

  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let ok = priorDone.length;
  let fixed = 0;
  let letterChanged = 0;
  let flagged = 0;
  let fixSkipped = 0;
  const byId = new Map(todo.map((r) => [r.id, r]));

  let doneBatches = 0;
  await mapPool(batches, CONCURRENCY, async (batch) => {
    const reviews = await reviewBatch(
      llm,
      batch.map((b) => ({ id: b.id, question: b.question, answer: b.answer }))
    );
    const seen = new Set<string>();

    for (const rev of reviews) {
      seen.add(rev.id);
      const row = byId.get(rev.id);
      if (!row) continue;

      // Local guard: never accept "ok" if distractors clearly missing
      if (
        rev.verdict === "ok" &&
        !hasDistractorRationales(row.answer, choiceLettersFromQuestion(row.question))
      ) {
        rev.verdict = "fix";
        rev.confidence = rev.confidence === "high" ? "medium" : rev.confidence;
        rev.issue =
          (rev.issue ? rev.issue + " " : "") +
          "Local check: explanation lacks why-wrong rationales for distractors.";
        if (!rev.correctedAnswer) {
          // Force flag if model said ok without providing a rewrite
          rev.verdict = "flag";
          rev.issue =
            "Auditor marked ok but explanation lacks distractor rationales and provided no rewrite.";
        }
      }

      if (rev.verdict === "ok") {
        ok++;
        continue;
      }

      const canAutoFix =
        rev.verdict === "fix" &&
        rev.correctedAnswer &&
        (rev.confidence === "high" ||
          // Same-letter explanation upgrades may apply on medium confidence
          (rev.confidence === "medium" &&
            extractAnswerLetter(rev.correctedAnswer) === extractAnswerLetter(row.answer)));

      if (canAutoFix && rev.correctedAnswer) {
        const newQ = (rev.correctedQuestion?.trim() || row.question).trim();
        const newA = rev.correctedAnswer.trim();
        const fmt = validateQuestionFormat(newQ, newA);
        if (!fmt.valid) {
          fixSkipped++;
          flagged++;
          await storage.flagQuestion(row.id, "rescreen-flagged");
          if (!flagIds.has(row.id)) {
            flagIds.add(row.id);
            flags.push({
              id: row.id,
              subsectionId: row.subsectionId,
              confidence: rev.confidence,
              issue: `Proposed fix failed format: ${fmt.errors.join("; ")}. ${rev.issue ?? ""}`,
              problems: rev.problems,
              questionPreview: row.question.slice(0, 240),
              answerPreview: row.answer.slice(0, 200),
              suggestedQuestion: rev.correctedQuestion,
              suggestedAnswer: rev.correctedAnswer,
              reviewedAt: new Date().toISOString(),
            });
          }
          continue;
        }
        if (!hasDistractorRationales(newA, choiceLettersFromQuestion(newQ))) {
          // Still missing distractors after "fix" — flag for human
          flagged++;
          await storage.flagQuestion(row.id, "rescreen-flagged");
          if (!flagIds.has(row.id)) {
            flagIds.add(row.id);
            flags.push({
              id: row.id,
              subsectionId: row.subsectionId,
              confidence: rev.confidence,
              issue: `Fix still missing distractor rationales. ${rev.issue ?? ""}`,
              problems: rev.problems,
              questionPreview: row.question.slice(0, 240),
              answerPreview: row.answer.slice(0, 200),
              suggestedQuestion: rev.correctedQuestion,
              suggestedAnswer: rev.correctedAnswer,
              reviewedAt: new Date().toISOString(),
            });
          }
          continue;
        }

        const oldLetter = extractAnswerLetter(row.answer);
        const newLetter = extractAnswerLetter(newA);
        if (oldLetter && newLetter && oldLetter !== newLetter) letterChanged++;

        const tags = Array.from(
          new Set([
            ...(Array.isArray(row.tags) ? row.tags : []),
            "rescreen-auto-fixed",
            ...(oldLetter !== newLetter ? ["rescreen-letter-changed"] : []),
          ])
        );
        await db
          .update(questions)
          .set({ question: newQ, answer: newA, tags, updatedAt: new Date() })
          .where(eq(questions.id, row.id));
        // Keep in-memory copy coherent for any later heuristic
        row.question = newQ;
        row.answer = newA;
        row.tags = tags;
        fixed++;
        continue;
      }

      // flag
      flagged++;
      await storage.flagQuestion(row.id, "rescreen-flagged");
      if (!flagIds.has(row.id)) {
        flagIds.add(row.id);
        flags.push({
          id: row.id,
          subsectionId: row.subsectionId,
          confidence: rev.confidence,
          issue:
            rev.issue ||
            (rev.verdict === "fix"
              ? "Fix proposed without sufficient confidence"
              : "Flagged on strict rescreen"),
          problems: rev.problems,
          questionPreview: row.question.slice(0, 240),
          answerPreview: row.answer.slice(0, 200),
          suggestedQuestion: rev.correctedQuestion,
          suggestedAnswer: rev.correctedAnswer,
          reviewedAt: new Date().toISOString(),
        });
      }
    }

    for (const b of batch) {
      if (!seen.has(b.id)) {
        flagged++;
        await storage.flagQuestion(b.id, "rescreen-flagged");
        if (!flagIds.has(b.id)) {
          flagIds.add(b.id);
          flags.push({
            id: b.id,
            subsectionId: b.subsectionId,
            confidence: "low",
            issue: "Missing from auditor response",
            questionPreview: b.question.slice(0, 240),
            answerPreview: b.answer.slice(0, 200),
            reviewedAt: new Date().toISOString(),
          });
        }
      }
    }

    doneBatches++;
    if (doneBatches % 20 === 0 || doneBatches === batches.length) {
      const progress = {
        doneBatches,
        totalBatches: batches.length,
        ok,
        fixed,
        letterChanged,
        flagged,
        fixSkipped,
      };
      console.log("progress", progress);
      fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
      fs.writeFileSync(
        FLAG_PATH,
        JSON.stringify({ updatedAt: new Date().toISOString(), flags }, null, 2)
      );
    }
  });

  const summary = {
    reviewedAt: new Date().toISOString(),
    provider: llm.provider,
    model: resolvedModel(llm.provider),
    totalLive: rows.length,
    skippedAlreadyRescreened: priorDone.length,
    remainingReviewed: todo.length,
    ok,
    autoFixed: fixed,
    letterChanged,
    flaggedThisRun: flagged,
    totalFlagsOnDisk: flags.length,
    fixSkippedFormat: fixSkipped,
    flagPath: FLAG_PATH,
  };
  fs.writeFileSync(FLAG_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), flags }, null, 2));
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log("Done:", summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
