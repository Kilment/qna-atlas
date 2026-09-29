/**
 * Attach a clinical image to a question.
 *
 * 1. Drop the source file in server/data/question-images/
 * 2. Run:
 *    IMPORT_DB=local npm run attach:question-image -- '<questionId>' my-xray.jpg --alt "Lateral hand radiograph"
 *
 * Copies the file to client/public/question-images/ and sets questions.image_url.
 */
import * as fs from "fs";
import * as path from "path";
import { storage } from "../storage";
import { pool } from "../db";
import { applyImportDatabaseUrl } from "./importDbTarget";

async function ensureQuestionImageColumns(): Promise<void> {
  await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_url" varchar(512)`);
  await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_alt" varchar(256)`);
}

const STAGING_DIR = path.join(process.cwd(), "server/data/question-images");
const PUBLISHED_DIR = path.join(process.cwd(), "client/public/question-images");
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function usage(): never {
  console.error(`
Usage:
  IMPORT_DB=local npm run attach:question-image -- '<questionId>' <sourceFilename> [options]

Use single quotes around the question id. These ids often contain $, *, or !;
double quotes let the shell expand them (e.g. "$O" becomes empty).

Options:
  --alt "description"   Alt text for accessibility (default: derived from filename)
  --unflag              Clear the content-audit flag
  --visible             Set visible=true (after attach; bypasses image-dependent guards when image is set)
  --dry-run             Preview without copying or updating the database

Example:
  IMPORT_DB=local npm run attach:question-image -- '(7ad=Wj*' treacher-collins.jpg --alt "Facial photograph" --unflag --visible
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let alt: string | undefined;
  let unflag = false;
  let visible = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--alt") {
      alt = argv[++i];
      if (!alt) usage();
    } else if (arg === "--unflag") {
      unflag = true;
    } else if (arg === "--visible") {
      visible = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      usage();
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 2) usage();
  const [questionId, sourceFilename] = positional;
  return { questionId, sourceFilename, alt, unflag, visible, dryRun };
}

function altFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base.replace(/[-_]+/g, " ").trim() || "Clinical Image";
}

function validateSourceFile(sourcePath: string, sourceFilename: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Source file not found: ${sourcePath}\nDrop the image in server/data/question-images/ first.`
    );
  }
  const ext = path.extname(sourceFilename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported file type "${ext}". Allowed: ${[...ALLOWED_EXT].join(", ")}`);
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${sourcePath}`);
  }
  if (stat.size > MAX_BYTES) {
    throw new Error(`File too large (${stat.size} bytes). Max ${MAX_BYTES} bytes.`);
  }
}

async function main() {
  const { questionId, sourceFilename, alt, unflag, visible, dryRun } = parseArgs(process.argv.slice(2));
  const target = applyImportDatabaseUrl();
  console.log(`Database target: ${target.label} (${target.host})`);
  await ensureQuestionImageColumns();

  const question = await storage.getQuestion(questionId);
  if (!question) {
    const hint = /[$`!]/.test(questionId)
      ? ""
      : "\nIf the id contains $, *, or !, wrap it in single quotes so the shell does not expand it.";
    throw new Error(`Question not found: ${questionId}${hint}`);
  }

  const sourcePath = path.join(STAGING_DIR, sourceFilename);
  validateSourceFile(sourcePath, sourceFilename);

  const destFilename = path.basename(sourceFilename);
  const destPath = path.join(PUBLISHED_DIR, destFilename);
  const publicUrl = `/question-images/${destFilename}`;
  const imageAlt = alt ?? altFromFilename(sourceFilename);

  console.log(JSON.stringify({
    questionId,
    sourcePath,
    destPath,
    publicUrl,
    imageAlt,
    unflag,
    visible,
    dryRun,
  }, null, 2));

  if (dryRun) {
    console.log("Dry run — no changes written.");
    return;
  }

  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  fs.copyFileSync(sourcePath, destPath);

  const updated = await storage.updateQuestionImage(questionId, publicUrl, imageAlt);
  if (!updated) {
    throw new Error(`Failed to update image for question ${questionId}`);
  }

  if (unflag) {
    const ok = await storage.unflagQuestion(questionId);
    if (!ok) console.warn("Warning: unflag did not apply (question may not have been flagged).");
  }

  if (visible) {
    const ok = await storage.updateQuestionVisibility(questionId, true);
    if (!ok) {
      throw new Error(
        "Image attached but visible=true failed. If the question is still flagged, run with --unflag as well."
      );
    }
  }

  console.log(`
Done.
  Question:  ${questionId}
  Image URL: ${publicUrl}
  Published: ${destPath}

Next: npm run content:export -- prs   (or ortho), then commit images + content JSON and deploy.
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
