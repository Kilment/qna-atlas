/**
 * Find representative, license-safe images on PubMed Central for a question that is missing one.
 *
 *   npm run agent:pmc-image -- --query "sacral pressure injury" [--question-id ID | --question-file q.json]
 *       [--avoid "pressure ulcer,stage IV"] [--extra 'case report[Title]']
 *       [--max-articles 15] [--max-figures 6] [--out-dir tmp/pmc-candidates] [--score] [--min-score 7]
 *
 * Steps: NCBI PMC search via E-utilities (open access + CC license prefilter; set NCBI_API_KEY for higher rate limits) -> PMC Open Access dataset
 * metadata (authoritative license, retraction flag) -> figure vetting (third-party markers, caption
 * answer leaks) -> download, downscale (never crop), re-encode -> optional vision scoring.
 *
 * It only reads public data and writes files locally. Nothing is published: the agent uploads a
 * chosen file with `npm run agent:api -- image <file>` and files a proposal through /fix.
 */
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { resolveClaudeModel } from "../../claudeModels";
import { agentRequest, configFromEnv } from "./questionAgentClient";
import {
  fetchArticleMeta,
  parseFigures,
  searchArticles,
  vetArticleFigures,
  type FetchLike,
  type FigureCandidate,
  type RejectedFigure,
} from "../../questionAgent/pmcFigures";

const UA = "PRSAtlasQuestionAgent/1.0 (open-access figure search; contact admin@prs-atlas.com)";
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MIN_INPUT_BYTES = 5 * 1024;
const MIN_DIMENSION = 400;
const MAX_DIMENSION = 1600;

const fetchFn: FetchLike = (url, init) =>
  fetch(url, { headers: { "User-Agent": UA, ...(init?.headers ?? {}) } });

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}
const has = (name: string) => process.argv.slice(2).includes(`--${name}`);

interface ScoredCandidate extends FigureCandidate {
  localPath: string;
  width: number;
  height: number;
  bytes: number;
  suggestedAlt: string;
  score?: VisionScore;
}

interface VisionScore {
  score: number;
  bodyPartMatch: boolean;
  modalityMatch: boolean;
  visibleTextLeak: boolean;
  multiPanel: boolean;
  summary: string;
  accepted: boolean;
}

async function loadQuestion(): Promise<{ question: string; answer: string } | null> {
  const file = arg("question-file");
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  const id = arg("question-id");
  if (!id) return null;
  const res = await agentRequest(configFromEnv(), "GET", `/question/${encodeURIComponent(id)}`);
  if (res.status !== 200) throw new Error(`Could not load question ${id}: HTTP ${res.status}`);
  return { question: res.body.item.question, answer: res.body.item.answer };
}

async function downloadAndPrepare(c: FigureCandidate, outDir: string): Promise<Omit<ScoredCandidate, keyof FigureCandidate | "score" | "suggestedAlt"> | { reject: string }> {
  const res = await fetchFn(c.imageUrl);
  if (!res.ok) return { reject: `download failed: HTTP ${res.status}` };
  const input = Buffer.from(await res.arrayBuffer());
  if (input.length < MIN_INPUT_BYTES) return { reject: "image too small (probably an icon)" };
  if (input.length > MAX_INPUT_BYTES) return { reject: "image too large" };
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) return { reject: "unreadable image" };
  if (Math.min(meta.width, meta.height) < MIN_DIMENSION) return { reject: `image too small (${meta.width}x${meta.height})` };
  // Downscale only; never crop. Flatten transparency so line art stays legible.
  const out = await sharp(input)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  fs.mkdirSync(outDir, { recursive: true });
  const safe = `${c.pmcid}-${c.figId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const localPath = path.join(outDir, `${safe}.jpg`);
  fs.writeFileSync(localPath, out.data);
  return { localPath, width: out.info.width, height: out.info.height, bytes: out.data.length };
}

async function scoreWithVision(
  client: Anthropic,
  model: string,
  question: { question: string; answer: string },
  candidate: ScoredCandidate,
  minScore: number
): Promise<VisionScore> {
  const image = fs.readFileSync(candidate.localPath).toString("base64");
  const prompt = `You are checking whether a figure is a suitable illustration for a board-exam question that has no image attached.

QUESTION (stem and choices):
${question.question.slice(0, 3500)}

KEYED ANSWER AND EXPLANATION:
${question.answer.slice(0, 1500)}

The figure is from a published article (not shown to learners with its caption). Judge only what you can see.
Reply with JSON only:
{"score": 0-10, "bodyPartMatch": bool, "modalityMatch": bool, "visibleTextLeak": bool, "multiPanel": bool, "summary": "one sentence"}
- score: how well the image depicts the finding the stem describes, at the anatomic site and modality described (10 = ideal, 0 = unrelated).
- bodyPartMatch: anatomic site, laterality and patient age group are consistent with the stem (false if the image shows a different body part).
- modalityMatch: photo vs radiograph vs CT vs MRI etc. matches what the stem implies.
- visibleTextLeak: any text, label, arrow annotation, or measurement in the image that names the diagnosis or answer.
- multiPanel: more than one panel/view (learners would need a single clear view).`;
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const score = Number(json.score) || 0;
  const bodyPartMatch = json.bodyPartMatch === true;
  const modalityMatch = json.modalityMatch === true;
  const visibleTextLeak = json.visibleTextLeak === true;
  return {
    score,
    bodyPartMatch,
    modalityMatch,
    visibleTextLeak,
    multiPanel: json.multiPanel === true,
    summary: String(json.summary ?? "").slice(0, 300),
    accepted: score >= minScore && bodyPartMatch && modalityMatch && !visibleTextLeak,
  };
}

async function main() {
  const terms = arg("query");
  if (!terms) throw new Error('--query "search terms" is required.');
  const avoid = (arg("avoid") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxArticles = Math.min(50, Number(arg("max-articles")) || 15);
  const maxFigures = Math.min(20, Number(arg("max-figures")) || 6);
  const outDir = path.resolve(arg("out-dir") ?? "tmp/pmc-candidates");
  const minScore = Number(arg("min-score")) || 7;
  const question = await loadQuestion();

  let client: Anthropic | null = null;
  const model = resolveClaudeModel(process.env.QUESTION_AGENT_VISION_MODEL, "claude-opus-5");
  if (has("score")) {
    const apiKey = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
    if (!apiKey) throw new Error("--score needs ANTHROPIC_API_KEY (or CLAUDE_API_KEY).");
    if (!question) throw new Error("--score needs --question-id or --question-file.");
    client = new Anthropic({ apiKey });
  }

  const hits = await searchArticles(fetchFn, terms, { extra: arg("extra"), pageSize: maxArticles });
  const rejected: RejectedFigure[] = [];
  const candidates: ScoredCandidate[] = [];
  let articlesChecked = 0;

  for (const hit of hits) {
    if (candidates.length >= maxFigures) break;
    articlesChecked++;
    let meta;
    try {
      meta = await fetchArticleMeta(fetchFn, hit.pmcid);
    } catch (err) {
      rejected.push({ pmcid: hit.pmcid, figId: "*", reason: `metadata error: ${(err as Error).message}` });
      continue;
    }
    if (!meta) {
      rejected.push({ pmcid: hit.pmcid, figId: "*", reason: "not in the PMC Open Access dataset" });
      continue;
    }
    const xmlRes = await fetchFn(`https://pmc-oa-opendata.s3.amazonaws.com/${meta.versionPrefix}/${meta.versionPrefix}.xml`);
    if (!xmlRes.ok) {
      rejected.push({ pmcid: hit.pmcid, figId: "*", reason: `XML unavailable (HTTP ${xmlRes.status})` });
      continue;
    }
    const figures = parseFigures(await xmlRes.text());
    const vetted = vetArticleFigures({ hit, meta, figures, avoidTerms: avoid });
    rejected.push(...vetted.rejected);

    for (const fig of vetted.accepted) {
      if (candidates.length >= maxFigures) break;
      const prepared = await downloadAndPrepare(fig, outDir).catch((e) => ({ reject: `processing failed: ${(e as Error).message}` }));
      if ("reject" in prepared) {
        rejected.push({ pmcid: fig.pmcid, figId: fig.figId, reason: prepared.reject });
        continue;
      }
      const candidate: ScoredCandidate = { ...fig, ...prepared, suggestedAlt: "Clinical Image" };
      if (client && question) {
        try {
          candidate.score = await scoreWithVision(client, model, question, candidate, minScore);
        } catch (e) {
          rejected.push({ pmcid: fig.pmcid, figId: fig.figId, reason: `vision scoring failed: ${(e as Error).message}` });
          continue;
        }
        if (!candidate.score.accepted) {
          rejected.push({
            pmcid: fig.pmcid,
            figId: fig.figId,
            reason: `vision score ${candidate.score.score}/10 (body part ${candidate.score.bodyPartMatch}, modality ${candidate.score.modalityMatch}, text leak ${candidate.score.visibleTextLeak})`,
          });
          fs.rmSync(candidate.localPath, { force: true });
          continue;
        }
      }
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0));
  console.log(
    JSON.stringify(
      {
        query: terms,
        articlesChecked,
        scored: !!client,
        note: client
          ? "Candidates passed vision scoring; still open each image and confirm before filing a proposal."
          : "Not vision-scored: open each localPath image yourself and check body part, laterality, modality, and visible text before using it.",
        candidates: candidates.map((c) => ({
          pmcid: c.pmcid,
          figId: c.figId,
          label: c.label,
          caption: c.caption,
          localPath: c.localPath,
          width: c.width,
          height: c.height,
          bytes: c.bytes,
          suggestedAlt: c.suggestedAlt,
          attribution: { pmcid: c.pmcid, credit: c.credit, license: c.license, sourceUrl: c.sourceUrl },
          score: c.score,
        })),
        rejected: rejected.slice(0, 60),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
