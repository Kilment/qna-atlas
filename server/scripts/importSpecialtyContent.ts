/**
 * Import a bundled specialty content file into an explicitly chosen database.
 *
 * The deployment does this automatically on startup (see content/contentBootstrap.ts);
 * this script is for driving the same import by hand when you do hold a target URL.
 *
 * Target: must be stated explicitly — see importDbTarget.ts.
 *
 * Defaults to insert-only, matching deploy-time promotion: new rows are inserted; existing
 * rows sync flagged/visible/images but keep production wording. Pass MODE=upsert only to
 * deliberately overwrite stems/answers from this file (a restore).
 *
 *   DRY_RUN=1 IMPORT_DATABASE_URL="postgresql://..." npm run content:import -- ortho
 *   IMPORT_DATABASE_URL="postgresql://..." npm run content:import -- ortho
 *   MODE=upsert IMPORT_DATABASE_URL="postgresql://..." npm run content:import -- ortho
 */
import pg from "pg";
import { isSpecialtyId, type SpecialtyId } from "@shared/specialties";
import { applyImportDatabaseUrl } from "./importDbTarget";
import {
  countSpecialtyContent,
  importSpecialtyContent,
  readSpecialtyContentFile,
  recordPromotion,
  type ImportMode,
} from "../content/specialtyContent";

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function resolveMode(): ImportMode {
  const raw = (process.env.MODE || "insert-only").trim().toLowerCase();
  if (raw !== "insert-only" && raw !== "upsert") {
    throw new Error(`MODE must be "insert-only" or "upsert" (got "${raw}").`);
  }
  return raw;
}

function resolveSpecialty(): SpecialtyId {
  const raw = (process.argv[2] || process.env.SPECIALTY || "").trim().toLowerCase();
  if (!isSpecialtyId(raw)) {
    throw new Error(`Pass a specialty: npm run content:import -- ortho   (got "${raw || "nothing"}")`);
  }
  return raw;
}

async function main() {
  const specialtyId = resolveSpecialty();
  const file = readSpecialtyContentFile(specialtyId);
  if (!file) {
    throw new Error(`No exported content for "${specialtyId}". Run: npm run content:export -- ${specialtyId}`);
  }

  const mode = resolveMode();
  const target = applyImportDatabaseUrl();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000 });

  try {
    const before = await countSpecialtyContent(pool, specialtyId);
    console.log(
      JSON.stringify({
        dryRun: DRY_RUN,
        mode,
        specialtyId,
        target: { label: target.label, host: target.host },
        exportedAt: file.exportedAt,
        sourceFingerprint: file.sourceFingerprint,
        fileCounts: file.counts,
        targetBefore: before,
      })
    );

    const counts = await importSpecialtyContent(pool, file, {
      mode,
      dryRun: DRY_RUN,
      onProgress: (done, total) => {
        if (done % 500 === 0 || done === total) console.log(`progress ${done}/${total}`);
      },
    });
    if (!DRY_RUN) await recordPromotion(pool, specialtyId, file, counts.questions);

    const after = DRY_RUN ? before : await countSpecialtyContent(pool, specialtyId);
    console.log(JSON.stringify({ dryRun: DRY_RUN, mode, written: counts, targetAfter: after }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
