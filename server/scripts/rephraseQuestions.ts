/**
 * Slightly rephrase every visible question (and its answer) using different wording.
 * Uses Claude or OpenAI to paraphrase while preserving meaning, correct answer, and format.
 * Answer explanations include why the correct choice is right and why each wrong choice is wrong.
 *
 * Usage:
 *   npx tsx server/scripts/rephraseQuestions.ts           # run (updates DB)
 *   npx tsx server/scripts/rephraseQuestions.ts --dry-run # preview only
 *   npx tsx server/scripts/rephraseQuestions.ts --batch-size 10
 *   npx tsx server/scripts/rephraseQuestions.ts --skip=1400   # resume after first 1400
 *
 * Requires: CLAUDE_API_KEY (preferred) or OPENAI_API_KEY or OPENAI_QUESTION_GENERATION_API_KEY
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_SONNET, claudeRejectsSamplingParams, resolveClaudeModel } from "../claudeModels";
import OpenAI from "openai";
import { db } from "../db";
import { questions } from "@shared/schema";
import { storage } from "../storage";
import { validateQuestionFormat } from "@shared/questionFormat";
import { eq, asc } from "drizzle-orm";

const DEFAULT_BATCH_SIZE = 5;
const DELAY_MS_BETWEEN_BATCHES = 1500;

const SYSTEM_PROMPT =
  "You rephrase multiple-choice questions and answers. Output only valid JSON: an array of objects with keys question and answer. The question string must have the stem then each choice on its own line starting with A), B), C), D), and optionally E)—no other format (no 'Option A:', no '1.'). Use \\n in JSON strings for newlines. Preserve meaning, correct answer letter, and choice count. Answer string must start with the correct letter and ) then newline then explanation. The explanation must include why the correct answer is correct and, for each wrong option, a brief reason why it is wrong.";

type LLMClient =
  | { provider: "claude"; client: Anthropic }
  | { provider: "openai"; client: OpenAI };

function getLLM(): LLMClient | null {
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (claudeKey) return { provider: "claude", client: new Anthropic({ apiKey: claudeKey }) };
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_QUESTION_GENERATION_API_KEY;
  if (openaiKey) return { provider: "openai", client: new OpenAI({ apiKey: openaiKey }) };
  return null;
}

function parseRephrasedBatch(raw: string): { question: string; answer: string }[] {
  let text = raw.trim();
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();
  const parsed = JSON.parse(text) as unknown;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: { question: string; answer: string }[] = [];
  for (const item of arr) {
    if (item && typeof item === "object" && typeof item.question === "string" && typeof item.answer === "string") {
      out.push({
        question: String(item.question).trim(),
        answer: String(item.answer).trim(),
      });
    }
  }
  return out;
}

function buildRephrasePrompt(batch: { id: string; question: string; answer: string }[]): string {
  const items = batch
    .map(
      (q, i) =>
        `[${i + 1}]\nQuestion:\n${q.question}\n\nAnswer:\n${q.answer}`
    )
    .join("\n\n---\n\n");
  return `Rephrase each of the following multiple-choice questions and their answers to use different wording while keeping the exact same meaning, the same correct answer letter, and the same structure.

CRITICAL - Question format (must be exact or validation will fail):
- The "question" string must be the full stem followed by each choice on its own line.
- Each choice line MUST start with the letter and a closing parenthesis: A), B), C), D), and optionally E). Example:
  "Which of the following is most appropriate?
A) First option text
B) Second option text
C) Third option text
D) Fourth option text"
- Do NOT use "Option A:", "1.", or other formats. Only "A)", "B)", "C)", "D)", "E)" at the start of each choice line. In the JSON, put a newline between the stem and each choice: in the "question" string value write \\n between lines (e.g. "stem?\\nA) first\\nB) second\\nC) third\\nD) fourth").

Rules:
- Change wording throughout: question stem, each option (A, B, C, D, etc.), and the answer explanation.
- Preserve: number of choices (4 or 5), correct answer letter, and the exact choice format above. Answer must start with "X)\\n" then the explanation.
- Explanation content (required): Include (1) why the correct answer is correct, and (2) for each wrong option, a brief reason why it is wrong. If the current answer only explains the correct choice, add concise reasons for why each incorrect option is wrong (e.g. "A is incorrect because... B is incorrect because..."). Keep the same clinical/educational accuracy.
- Output a JSON array of exactly ${batch.length} objects with keys "question" and "answer", in the same order as the input. Use \\n inside JSON strings for newlines.

Input:

${items}

Respond with only the JSON array, no other text.`;
}

async function rephraseBatchWithClaude(
  client: Anthropic,
  batch: { id: string; question: string; answer: string }[]
): Promise<{ question: string; answer: string }[]> {
  const model = resolveClaudeModel(process.env.CLAUDE_REPHRASE_MODEL, CLAUDE_SONNET);
  const response = await client.messages.create({
    model,
    max_tokens: 16384,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildRephrasePrompt(batch) }],
    ...(claudeRejectsSamplingParams(model) ? {} : { temperature: 0.4 }),
  });
  const block = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
  if (!block) return [];
  return parseRephrasedBatch(block.text);
}

async function rephraseBatchWithOpenAI(
  client: OpenAI,
  batch: { id: string; question: string; answer: string }[]
): Promise<{ question: string; answer: string }[]> {
  const model = process.env.OPENAI_QUESTION_GENERATION_MODEL || "gpt-4o-mini";
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildRephrasePrompt(batch) },
    ],
    temperature: 0.4,
    max_tokens: 16384,
  });
  const content = response.choices?.[0]?.message?.content;
  if (!content) return [];
  return parseRephrasedBatch(content);
}

async function rephraseBatch(
  llm: LLMClient,
  batch: { id: string; question: string; answer: string }[]
): Promise<{ question: string; answer: string }[]> {
  if (llm.provider === "claude") return rephraseBatchWithClaude(llm.client, batch);
  return rephraseBatchWithOpenAI(llm.client, batch);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const batchSizeArg = process.argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchSizeArg ? Math.max(1, parseInt(batchSizeArg.split("=")[1], 10) || DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
  const skipArg = process.argv.find((a) => a.startsWith("--skip="));
  const skip = skipArg ? Math.max(0, parseInt(skipArg.split("=")[1], 10) || 0) : 0;

  const llm = getLLM();
  if (!llm) {
    console.error("Set CLAUDE_API_KEY or OPENAI_API_KEY or OPENAI_QUESTION_GENERATION_API_KEY to run this script.");
    process.exit(1);
  }
  console.log(`Using ${llm.provider} for rephrasing.`);

  const allVisible = await db
    .select({ id: questions.id, question: questions.question, answer: questions.answer })
    .from(questions)
    .where(eq(questions.visible, true))
    .orderBy(asc(questions.id));

  let rows = allVisible.filter((r) => {
    const result = validateQuestionFormat(r.question, r.answer);
    return result.valid;
  });
  const skippedCount = allVisible.length - rows.length;
  if (skippedCount > 0) console.log(`Skipping ${skippedCount} visible questions that fail format validation.`);
  if (skip > 0) {
    rows = rows.slice(skip);
    console.log(`Resuming: skipping first ${skip} questions; ${rows.length} remaining.`);
  }
  console.log(`Rephrasing ${rows.length} visible, validated questions. Batch size: ${batchSize}. Dry run: ${dryRun}`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const rephrased = await rephraseBatch(llm, batch);
    if (rephrased.length !== batch.length) {
      console.warn(`Batch ${i / batchSize + 1}: expected ${batch.length} items, got ${rephrased.length}; skipping batch`);
      failed += batch.length;
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const orig = batch[j];
      const next = rephrased[j];
      const result = validateQuestionFormat(next.question, next.answer);
      if (!result.valid) {
        console.warn(`Validation failed for ${orig.id}: ${result.errors.join("; ")}`);
        failed++;
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] Would update ${orig.id}`);
        updated++;
        continue;
      }
      const ok = await storage.updateQuestionText(orig.id, next.question, next.answer);
      if (ok) updated++;
      else failed++;
    }
    if ((i + batchSize) % 50 < batchSize) {
      console.log(`Progress: ${Math.min(i + batchSize, rows.length)} / ${rows.length}`);
    }
    if (i + batchSize < rows.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS_BETWEEN_BATCHES));
    }
  }

  console.log(`Done. Updated: ${updated}, Failed: ${failed}`);
  if (dryRun) console.log("Run without --dry-run to apply changes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
