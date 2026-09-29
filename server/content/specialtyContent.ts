/**
 * Dev → production content promotion.
 *
 * Production runs on its own database and the workspace holds no credentials for it,
 * so content travels in the repo instead of over a direct connection: the exporter
 * writes a specialty's sections/subsections/questions to a JSON file that ships with
 * the deploy, and the importer loads that file into whichever database the process is
 * connected to.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { type SpecialtyId } from "@shared/specialties";

/**
 * Accepts a checked-out client as well as a pool: advisory locks are session-scoped, so
 * the caller holding one must run its statements on that same connection.
 */
export type Queryable = Pool | PoolClient;

export const CONTENT_FILE_FORMAT = 3;

export type ContentSection = {
  id: string;
  specialtyId: SpecialtyId;
  title: string;
  sortOrder: number;
};

export type ContentSubsection = {
  id: string;
  sectionId: string;
  title: string;
  sortOrder: number;
};

export type ContentQuestion = {
  id: string;
  subsectionId: string;
  question: string;
  answer: string;
  tags: string[];
  source: string;
  visible: boolean;
  reported: boolean;
  flagged: boolean;
  imageUrl?: string | null;
  imageAlt?: string | null;
  imageSourcePmcid?: string | null;
  imageCredit?: string | null;
  imageLicense?: string | null;
  imageSourceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SpecialtyContentFile = {
  formatVersion: number;
  specialtyId: SpecialtyId;
  exportedAt: string;
  /** sha256 of the source database host, so an export can be traced back to its origin. */
  sourceFingerprint: string;
  /** sha256 of the content itself. Lets a deploy skip work when nothing changed. */
  contentHash: string;
  counts: { sections: number; subsections: number; questions: number };
  sections: ContentSection[];
  subsections: ContentSubsection[];
  questions: ContentQuestion[];
};

export function contentDir(): string {
  return path.join(process.cwd(), "server", "data", "content");
}

export function contentFilePath(specialtyId: SpecialtyId): string {
  return path.join(contentDir(), `${specialtyId}.content.json`);
}

/**
 * Which sections belong to a specialty. Mirrors sectionsMatchSpecialty() in storage.ts,
 * including the legacy `ortho-` id prefix that predates the specialty_id column.
 */
export function sectionSelectSql(specialtyId: SpecialtyId): string {
  return specialtyId === "ortho"
    ? "(specialty_id = 'ortho' OR id LIKE 'ortho-%')"
    : "(specialty_id = 'prs' AND id NOT LIKE 'ortho-%')";
}

/**
 * Presence test that works on databases predating the specialty_id column, so it is safe
 * to run before the schema guards. Id prefixes alone decide the specialty here.
 */
export function contentPresenceSql(specialtyId: SpecialtyId): string {
  return specialtyId === "ortho" ? "id LIKE 'ortho-%'" : "id NOT LIKE 'ortho-%'";
}

export function readSpecialtyContentFile(specialtyId: SpecialtyId): SpecialtyContentFile | null {
  const file = contentFilePath(specialtyId);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SpecialtyContentFile;
  if (parsed.formatVersion !== CONTENT_FILE_FORMAT) {
    throw new Error(
      `${path.basename(file)} is format ${parsed.formatVersion}, expected ${CONTENT_FILE_FORMAT}. Re-run the exporter.`
    );
  }
  if (parsed.specialtyId !== specialtyId) {
    throw new Error(`${path.basename(file)} declares specialty "${parsed.specialtyId}", expected "${specialtyId}".`);
  }
  return parsed;
}

/**
 * Brings a target database up to the columns the content tables need. Older databases
 * (production predates the multi-specialty work) lack specialty_id and flagged, and an
 * insert naming them would fail. Idempotent.
 */
export async function applyContentSchemaGuards(target: Queryable): Promise<void> {
  const migration = path.join(process.cwd(), "drizzle", "0016_multi_specialty.sql");
  if (fs.existsSync(migration)) {
    await target.query(fs.readFileSync(migration, "utf8"));
  }
  await target.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS flagged boolean DEFAULT false NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_questions_flagged ON questions (flagged);
  `);
  await target.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url varchar(512);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_alt varchar(256);
  `);
  await ensureImageAttributionColumns(target);
  await target.query(`
    CREATE TABLE IF NOT EXISTS content_promotions (
      specialty_id varchar(32) PRIMARY KEY,
      content_hash varchar(64) NOT NULL,
      exported_at timestamp NOT NULL,
      promoted_at timestamp NOT NULL DEFAULT now(),
      inserted_questions integer NOT NULL DEFAULT 0
    );
  `);
}

/** Image attribution columns (open-access figures). Idempotent. */
export async function ensureImageAttributionColumns(target: Queryable): Promise<void> {
  await target.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_source_pmcid varchar(32);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_credit varchar(512);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_license varchar(64);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_source_url varchar(512);
  `);
}

/**
 * Deterministic hash of the content, independent of when it was exported.
 * Includes a promotion-semantics marker so changing what insert-only syncs forces a
 * re-promote on deploy even when question rows are otherwise unchanged.
 */
export function computeContentHash(parts: {
  sections: ContentSection[];
  subsections: ContentSubsection[];
  questions: ContentQuestion[];
}): string {
  const hash = createHash("sha256");
  hash.update("promotion:insert-only-syncs-flagged-visible-images-lww-v3\n");
  for (const s of [...parts.sections].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`S:${s.id}:${s.specialtyId}:${s.title}:${s.sortOrder}\n`);
  }
  for (const s of [...parts.subsections].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`U:${s.id}:${s.sectionId}:${s.title}:${s.sortOrder}\n`);
  }
  for (const q of [...parts.questions].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`Q:${q.id}:${q.subsectionId}:${q.question}:${q.answer}:${q.visible}:${q.flagged}:${q.imageUrl ?? ""}:${q.imageAlt ?? ""}:${q.imageSourcePmcid ?? ""}:${q.imageCredit ?? ""}:${q.imageLicense ?? ""}:${q.imageSourceUrl ?? ""}\n`);
  }
  return hash.digest("hex");
}

/** Hash of the last content file promoted into this database, if any. */
export async function readPromotedHash(target: Queryable, specialtyId: SpecialtyId): Promise<string | null> {
  try {
    const { rows } = await target.query<{ content_hash: string }>(
      "SELECT content_hash FROM content_promotions WHERE specialty_id = $1",
      [specialtyId]
    );
    return rows[0]?.content_hash ?? null;
  } catch {
    // Ledger table not created yet — treat as never promoted.
    return null;
  }
}

export async function recordPromotion(
  target: Queryable,
  specialtyId: SpecialtyId,
  file: SpecialtyContentFile,
  insertedQuestions: number
): Promise<void> {
  await target.query(
    `INSERT INTO content_promotions (specialty_id, content_hash, exported_at, promoted_at, inserted_questions)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (specialty_id) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       exported_at = EXCLUDED.exported_at,
       promoted_at = EXCLUDED.promoted_at,
       inserted_questions = EXCLUDED.inserted_questions`,
    [specialtyId, file.contentHash, file.exportedAt, insertedQuestions]
  );
}

/**
 * Question wording on production is authoritative (audit agent revisions). Promotion modes:
 * - insert-only (deploy default): insert new questions; on conflict sync visibility controls
 *   (flagged, visible) and media (image_url, image_alt and attribution) from the content file, but
 *   never overwrite stem/answer/tags/source/subsection. The sync is last-writer-wins: a production
 *   row edited after the content file's copy (for example by the question-fix agent or an admin) is
 *   left alone, so a deploy cannot revert live fixes.
 * - upsert: full overwrite from the content file — operator-driven restore only.
 */
export type ImportMode = "insert-only" | "upsert";

export type ImportCounts = {
  sections: number;
  subsections: number;
  /** Rows returned from INSERT…ON CONFLICT (inserts + updates that ran). */
  questions: number;
  /** Batch size minus returned rows (normally 0 when conflict updates always apply). */
  questionsSkipped: number;
};

/** Rows per multi-row insert. 17 columns x 100 rows stays far below the 65535 parameter cap. */
const BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Promotes a content file into `target`. Idempotent, and never deletes.
 *
 * Section and subsection rows are always updated — they are structural, and nothing
 * edits them downstream. Question rows follow `mode` (see ImportMode): insert-only keeps
 * production wording intact while syncing flagged/visible/images.
 */
export async function importSpecialtyContent(
  target: Queryable,
  file: SpecialtyContentFile,
  options: {
    mode?: ImportMode;
    dryRun?: boolean;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<ImportCounts> {
  const { mode = "insert-only", dryRun = false, onProgress } = options;
  const counts: ImportCounts = { sections: 0, subsections: 0, questions: 0, questionsSkipped: 0 };
  if (dryRun) {
    return {
      sections: file.sections.length,
      subsections: file.subsections.length,
      questions: file.questions.length,
      questionsSkipped: 0,
    };
  }

  await applyContentSchemaGuards(target);

  for (const s of file.sections) {
    await target.query(
      `INSERT INTO sections (id, specialty_id, title, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         specialty_id = EXCLUDED.specialty_id,
         title = EXCLUDED.title,
         sort_order = EXCLUDED.sort_order`,
      [s.id, s.specialtyId, s.title, s.sortOrder]
    );
    counts.sections++;
  }

  for (const s of file.subsections) {
    await target.query(
      `INSERT INTO subsections (id, section_id, title, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         section_id = EXCLUDED.section_id,
         title = EXCLUDED.title,
         sort_order = EXCLUDED.sort_order`,
      [s.id, s.sectionId, s.title, s.sortOrder]
    );
    counts.subsections++;
  }

  for (const batch of chunk(file.questions, BATCH_SIZE)) {
    const values: unknown[] = [];
    const tuples = batch.map((q, row) => {
      const base = row * 17;
      values.push(
        q.id,
        q.subsectionId,
        q.question,
        q.answer,
        JSON.stringify(Array.isArray(q.tags) ? q.tags : []),
        q.source,
        q.visible,
        q.reported,
        q.flagged,
        q.imageUrl ?? null,
        q.imageAlt ?? null,
        q.imageSourcePmcid ?? null,
        q.imageCredit ?? null,
        q.imageLicense ?? null,
        q.imageSourceUrl ?? null,
        q.createdAt,
        q.updatedAt
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17})`;
    });

    const conflict =
      mode === "upsert"
        ? `DO UPDATE SET
             subsection_id = EXCLUDED.subsection_id,
             question = EXCLUDED.question,
             answer = EXCLUDED.answer,
             tags = EXCLUDED.tags,
             source = EXCLUDED.source,
             visible = EXCLUDED.visible,
             reported = EXCLUDED.reported,
             flagged = EXCLUDED.flagged,
             image_url = EXCLUDED.image_url,
             image_alt = EXCLUDED.image_alt,
             image_source_pmcid = EXCLUDED.image_source_pmcid,
             image_credit = EXCLUDED.image_credit,
             image_license = EXCLUDED.image_license,
             image_source_url = EXCLUDED.image_source_url,
             updated_at = EXCLUDED.updated_at`
        : `DO UPDATE SET
             visible = EXCLUDED.visible,
             flagged = EXCLUDED.flagged,
             image_url = EXCLUDED.image_url,
             image_alt = EXCLUDED.image_alt,
             image_source_pmcid = EXCLUDED.image_source_pmcid,
             image_credit = EXCLUDED.image_credit,
             image_license = EXCLUDED.image_license,
             image_source_url = EXCLUDED.image_source_url,
             updated_at = EXCLUDED.updated_at
           WHERE questions.updated_at <= EXCLUDED.updated_at`;

    const written = await target.query(
      `INSERT INTO questions (
         id, subsection_id, question, answer, tags, source,
         visible, reported, flagged, image_url, image_alt,
         image_source_pmcid, image_credit, image_license, image_source_url, created_at, updated_at
       ) VALUES ${tuples.join(", ")}
       ON CONFLICT (id) ${conflict}
       RETURNING id`,
      values
    );
    counts.questions += written.rowCount ?? 0;
    counts.questionsSkipped += batch.length - (written.rowCount ?? 0);
    onProgress?.(counts.questions + counts.questionsSkipped, file.questions.length);
  }

  return counts;
}

/**
 * Read a specialty's content from `source` into the export file shape. Used by the export CLI
 * (workspace DB) and by the question-agent export endpoint (live production DB).
 */
export async function buildSpecialtyContentFile(
  source: Queryable,
  specialtyId: SpecialtyId,
  sourceFingerprint: string
): Promise<{ file: SpecialtyContentFile; orphanQuestionsSkipped: number }> {
  await ensureImageAttributionColumns(source);
  const sectionRows = await source.query<{
    id: string;
    specialty_id: SpecialtyId;
    title: string;
    sort_order: number;
  }>(`SELECT id, specialty_id, title, sort_order FROM sections WHERE ${sectionSelectSql(specialtyId)} ORDER BY sort_order, id`);

  const sectionIds = sectionRows.rows.map((r) => r.id);
  if (sectionIds.length === 0) {
    throw new Error(`No ${specialtyId} sections in the source database — nothing to export.`);
  }

  const subsectionRows = await source.query<{
    id: string;
    section_id: string;
    title: string;
    sort_order: number;
  }>(
    `SELECT id, section_id, title, sort_order FROM subsections
     WHERE section_id = ANY($1::varchar[]) ORDER BY sort_order, id`,
    [sectionIds]
  );
  const subsectionIds = subsectionRows.rows.map((r) => r.id);

  const questionRows = await source.query<{
    id: string;
    subsection_id: string;
    question: string;
    answer: string;
    tags: string[] | null;
    source: string;
    visible: boolean;
    reported: boolean;
    flagged: boolean;
    image_url: string | null;
    image_alt: string | null;
    image_source_pmcid: string | null;
    image_credit: string | null;
    image_license: string | null;
    image_source_url: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, subsection_id, question, answer, tags, source, visible, reported, flagged, image_url, image_alt,
            image_source_pmcid, image_credit, image_license, image_source_url, created_at, updated_at
     FROM questions WHERE subsection_id = ANY($1::varchar[]) ORDER BY id`,
    [subsectionIds]
  );

  // Questions carrying the specialty's id prefix but parented outside its sections would
  // be silently dropped, so surface them rather than exporting a quietly short bank.
  const orphans = await source.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM questions
     WHERE ${specialtyId === "ortho" ? "id LIKE 'ortho-%'" : "id NOT LIKE 'ortho-%'"}
       AND NOT (subsection_id = ANY($1::varchar[]))`,
    [subsectionIds]
  );

  const sections: ContentSection[] = sectionRows.rows.map((r) => ({
    id: r.id,
    specialtyId: r.specialty_id ?? specialtyId,
    title: r.title,
    sortOrder: r.sort_order,
  }));
  const subsections: ContentSubsection[] = subsectionRows.rows.map((r) => ({
    id: r.id,
    sectionId: r.section_id,
    title: r.title,
    sortOrder: r.sort_order,
  }));
  const questions: ContentQuestion[] = questionRows.rows.map((r) => ({
    id: r.id,
    subsectionId: r.subsection_id,
    question: r.question,
    answer: r.answer,
    tags: Array.isArray(r.tags) ? r.tags : [],
    source: r.source,
    visible: r.visible,
    reported: r.reported,
    flagged: r.flagged,
    imageUrl: r.image_url,
    imageAlt: r.image_alt,
    imageSourcePmcid: r.image_source_pmcid,
    imageCredit: r.image_credit,
    imageLicense: r.image_license,
    imageSourceUrl: r.image_source_url,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));

  const file: SpecialtyContentFile = {
    formatVersion: CONTENT_FILE_FORMAT,
    specialtyId,
    exportedAt: new Date().toISOString(),
    sourceFingerprint,
    contentHash: computeContentHash({ sections, subsections, questions }),
    counts: {
      sections: sections.length,
      subsections: subsections.length,
      questions: questions.length,
    },
    sections,
    subsections,
    questions,
  };
  return { file, orphanQuestionsSkipped: orphans.rows[0]?.n ?? 0 };
}

/** How much of a specialty's content the target already holds. */
export async function countSpecialtyContent(
  target: Queryable,
  specialtyId: SpecialtyId
): Promise<{ sections: number; questions: number }> {
  const presence = contentPresenceSql(specialtyId);
  const { rows } = await target.query<{ sections: number; questions: number }>(`
    SELECT
      (SELECT count(*)::int FROM sections  WHERE ${presence}) AS sections,
      (SELECT count(*)::int FROM questions WHERE ${presence}) AS questions
  `);
  return rows[0] ?? { sections: 0, questions: 0 };
}
