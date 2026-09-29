/**
 * Pull the live production question bank into the repo's content file (production -> repo).
 *
 * Production is the source of truth for question wording (admins, the feedback agent and the
 * question-fix agent all edit it live). This snapshot keeps server/data/content/<specialty>.content.json
 * in line with it, so a later deploy or an operator-driven `MODE=upsert` restore cannot overwrite
 * live fixes with stale text.
 *
 *   QUESTION_AGENT_BASE_URL=https://prs-atlas.com QUESTION_AGENT_TOKEN=... \
 *   npm run agent:pull-prod -- prs [--dry-run] [--force]
 *
 * To also bring the workspace database in line afterwards:
 *   IMPORT_DB=local MODE=upsert npm run content:import -- prs
 */
import * as fs from "fs";
import { isSpecialtyId } from "@shared/specialties";
import { contentDir, contentFilePath, type SpecialtyContentFile } from "../../content/specialtyContent";
import { diffContent, validateSnapshot } from "../../questionAgent/snapshot";
import { agentRequest, configFromEnv } from "./questionAgentClient";

async function main() {
  const args = process.argv.slice(2);
  const specialty = args.find((a) => !a.startsWith("--"));
  if (!specialty || !isSpecialtyId(specialty)) throw new Error("Usage: npm run agent:pull-prod -- <prs|ortho> [--dry-run] [--force]");
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  const res = await agentRequest(configFromEnv(), "GET", "/export", { query: { specialty } });
  if (res.status !== 200) throw new Error(`Export failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  const incoming = res.body.file as SpecialtyContentFile;

  const errors = validateSnapshot(incoming, specialty);
  if (errors.length > 0) throw new Error(`Refusing to write snapshot: ${errors.join("; ")}`);

  const outPath = contentFilePath(specialty);
  let current: SpecialtyContentFile | null = null;
  if (fs.existsSync(outPath)) current = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const diff = diffContent(current, incoming);

  if (current && !force && incoming.questions.length < current.questions.length * 0.95) {
    throw new Error(
      `Production has ${incoming.questions.length} questions vs ${current.questions.length} in the repo file (more than 5% fewer). Pass --force if that is expected.`
    );
  }

  const summary = {
    specialty,
    productionQuestions: incoming.questions.length,
    repoFileQuestions: current?.questions.length ?? 0,
    diffVsRepoFile: diff,
    orphanQuestionsSkipped: res.body.orphanQuestionsSkipped ?? 0,
    wrote: false,
    file: outPath,
  };
  if (!dryRun) {
    fs.mkdirSync(contentDir(), { recursive: true });
    // Keep the export honest about its origin.
    const payload: SpecialtyContentFile = { ...incoming, sourceFingerprint: "production" };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 0)}\n`);
    summary.wrote = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
