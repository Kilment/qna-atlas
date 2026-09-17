/**
 * Promotes bundled q-bank content into the database this process is connected to.
 *
 * Production runs on its own database that the workspace cannot reach, so content
 * authored in dev travels in the repo and is promoted here, on deploy.
 *
 * Insert-only promotion (deploy default):
 * - Inserts questions this database has never seen
 * - On existing rows, syncs flagged / visible / image_url / image_alt from the content file
 * - Never overwrites stem, answer, tags, source, or subsection (production wording stays)
 *
 * Full overwrite is available via `MODE=upsert npm run content:import`, not from here.
 *
 * Set CONTENT_BOOTSTRAP=0 to skip entirely.
 */
import { pool } from "../db";
import { SPECIALTY_IDS, type SpecialtyId } from "@shared/specialties";
import {
  applyContentSchemaGuards,
  countSpecialtyContent,
  importSpecialtyContent,
  readPromotedHash,
  readSpecialtyContentFile,
  recordPromotion,
} from "./specialtyContent";

/** Arbitrary but stable; no other advisory locks exist in this codebase. */
const LOCK_BASE = 528000;

function lockKey(specialtyId: SpecialtyId): number {
  return LOCK_BASE + SPECIALTY_IDS.indexOf(specialtyId);
}

export async function runContentBootstrap(logger: (message: string) => void = console.log): Promise<void> {
  if (process.env.CONTENT_BOOTSTRAP === "0") return;

  for (const specialtyId of SPECIALTY_IDS) {
    try {
      const file = readSpecialtyContentFile(specialtyId);
      if (!file) continue;

      // Cheap guard: skip when this exact content has already been promoted here.
      if ((await readPromotedHash(pool, specialtyId)) === file.contentHash) continue;

      // Autoscale runs several instances, which cold-start together. The lock is tied to
      // one session, so every statement below has to use this same client.
      const client = await pool.connect();
      try {
        const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
          lockKey(specialtyId),
        ]);
        if (!lock.rows[0]?.ok) {
          logger(`[contentBootstrap] ${specialtyId} promotion already running in another instance — skipping`);
          continue;
        }

        try {
          await applyContentSchemaGuards(client);
          if ((await readPromotedHash(client, specialtyId)) === file.contentHash) continue;

          const counts = await importSpecialtyContent(client, file, { mode: "insert-only" });
          await recordPromotion(client, specialtyId, file, counts.questions);
          const after = await countSpecialtyContent(client, specialtyId);
          logger(
            `[contentBootstrap] ${specialtyId} promoted: wrote ${counts.questions} question rows (insert + flagged/visible/image sync; skipped ${counts.questionsSkipped}); bank now ${after.sections} sections / ${after.questions} questions`
          );
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockKey(specialtyId)]);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      logger(`[contentBootstrap] ${specialtyId} failed: ${(error as Error).message}`);
    }
  }
}
