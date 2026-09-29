/**
 * Export one specialty's q-bank content to a JSON file that ships with the repo.
 *
 * Source: DATABASE_URL (the workspace database — where content is authored)
 * Output: server/data/content/<specialty>.content.json
 *
 * The deployment imports this file on startup, which is how content reaches the
 * production database without the workspace needing production credentials.
 *
 *   npm run content:export -- ortho
 *   npm run content:export -- prs
 */
import * as fs from "fs";
import pg from "pg";
import { createHash } from "crypto";
import { isSpecialtyId, type SpecialtyId } from "@shared/specialties";
import {
  buildSpecialtyContentFile,
  contentDir,
  contentFilePath,
} from "../content/specialtyContent";

function resolveSpecialty(): SpecialtyId {
  const raw = (process.argv[2] || process.env.SPECIALTY || "").trim().toLowerCase();
  if (!isSpecialtyId(raw)) {
    throw new Error(`Pass a specialty: npm run content:export -- ortho   (got "${raw || "nothing"}")`);
  }
  return raw;
}

function fingerprint(url: string): string {
  try {
    return createHash("sha256").update(new URL(url).hostname).digest("hex").slice(0, 10);
  } catch {
    return "unknown";
  }
}

async function main() {
  const specialtyId = resolveSpecialty();
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required (the workspace database is the source).");

  const source = new pg.Pool({ connectionString: sourceUrl, connectionTimeoutMillis: 20000 });
  try {
    const { file: payload, orphanQuestionsSkipped } = await buildSpecialtyContentFile(
      source,
      specialtyId,
      fingerprint(sourceUrl)
    );

    fs.mkdirSync(contentDir(), { recursive: true });
    const outPath = contentFilePath(specialtyId);
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 0)}\n`);

    console.log(
      JSON.stringify(
        {
          specialtyId,
          sourceFingerprint: payload.sourceFingerprint,
          contentHash: payload.contentHash.slice(0, 12),
          ...payload.counts,
          orphanQuestionsSkipped,
          file: outPath,
          sizeMb: +(fs.statSync(outPath).size / 1024 / 1024).toFixed(2),
        },
        null,
        2
      )
    );
  } finally {
    await source.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
