/**
 * One-time (and repeatable) reconciliation: ship fixes that only exist in the workspace database
 * to production through the guarded agent API instead of an upsert import.
 *
 * For every question whose stem or answer differs between the workspace DB and production, and
 * where the workspace row was edited after the production row, it files a fix through
 * POST /fix. The same tier rules apply as for the agent: safe edits apply immediately, key changes
 * and rewrites become Slack proposals, and stale writes are rejected.
 *
 *   QUESTION_AGENT_BASE_URL=... QUESTION_AGENT_TOKEN=... \
 *   npm run agent:reconcile -- prs [--apply] [--only=id1,id2] [--limit=25]
 *
 * Default is a dry run that classifies every difference and writes nothing.
 * Uses DATABASE_URL (the workspace DB) for the local side; it never connects to production.
 */
import pg from "pg";
import { isSpecialtyId, type SpecialtyId } from "@shared/specialties";
import type { SpecialtyContentFile } from "../../content/specialtyContent";
import { hashQuestion } from "../../questionAgent/hash";
import { agentRequest, configFromEnv } from "./questionAgentClient";

interface LocalRow {
  id: string;
  question: string;
  answer: string;
  visible: boolean;
  flagged: boolean;
  image_url: string | null;
  updated_at: Date;
}

async function main() {
  const args = process.argv.slice(2);
  const specialty = args.find((a) => !a.startsWith("--"));
  if (!specialty || !isSpecialtyId(specialty)) throw new Error("Usage: npm run agent:reconcile -- <prs|ortho> [--apply] [--only=ids] [--limit=N]");
  const apply = args.includes("--apply");
  const only = new Set((args.find((a) => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean));
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 25;

  const cfg = configFromEnv();
  const exportRes = await agentRequest(cfg, "GET", "/export", { query: { specialty } });
  if (exportRes.status !== 200) throw new Error(`Export failed: HTTP ${exportRes.status}`);
  const prod = new Map((exportRes.body.file as SpecialtyContentFile).questions.map((q) => [q.id, q]));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL (workspace DB) is required.");
  const pool = new pg.Pool({ connectionString: dbUrl });
  let rows: LocalRow[];
  try {
    const prefix = (specialty as SpecialtyId) === "ortho" ? "id LIKE 'ortho-%'" : "id NOT LIKE 'ortho-%'";
    rows = (
      await pool.query<LocalRow>(
        `SELECT id, question, answer, visible, flagged, image_url, updated_at FROM questions WHERE ${prefix} ORDER BY id`
      )
    ).rows;
  } finally {
    await pool.end();
  }

  const runId = `reconcile-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const report: Record<string, unknown>[] = [];
  let processed = 0;
  for (const local of rows) {
    if (only.size > 0 && !only.has(local.id)) continue;
    const remote = prod.get(local.id);
    if (!remote) continue; // new questions travel with the deploy (insert-only import)
    const textDiffers = local.question !== remote.question || local.answer !== remote.answer;
    const localNewer = new Date(local.updated_at).getTime() > new Date(remote.updatedAt).getTime();
    const wantsUnhide = local.visible && !local.flagged && (!remote.visible || remote.flagged);
    if (!textDiffers && !wantsUnhide) continue;
    if (!localNewer) {
      report.push({ id: local.id, result: "skipped", reason: "production row was edited more recently" });
      continue;
    }
    if (processed >= limit) {
      report.push({ id: local.id, result: "deferred", reason: `limit ${limit} reached; rerun to continue` });
      continue;
    }
    processed++;
    const body: Record<string, unknown> = {
      questionId: local.id,
      runId,
      baseHash: hashQuestion(remote.question, remote.answer),
      rationale: "Reconcile: this fix was made in the workspace database and is being shipped through the guarded API.",
      ...(textDiffers ? { question: local.question, answer: local.answer } : {}),
      ...(wantsUnhide ? { unhide: true } : {}),
    };
    const res = await agentRequest(cfg, "POST", "/fix", { query: { dryRun: apply ? undefined : "true" }, json: body });
    report.push({
      id: local.id,
      http: res.status,
      result: res.body?.status ?? "error",
      tier: res.body?.tier,
      reasons: res.body?.reasons ?? res.body?.errors ?? res.body?.blockers ?? res.body?.message,
      proposalId: res.body?.proposalId,
    });
    if (res.status === 429) {
      report.push({ result: "stopped", reason: "cap reached; rerun later or raise QUESTION_AGENT_MAX_AUTO_PER_* for this run" });
      break;
    }
  }

  const tally: Record<string, number> = {};
  for (const r of report) tally[String(r.result)] = (tally[String(r.result)] ?? 0) + 1;
  console.log(JSON.stringify({ specialty, mode: apply ? "apply" : "dry-run", runId, tally, report }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
