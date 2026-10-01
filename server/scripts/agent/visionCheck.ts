/**
 * Two-model image check with prompt caching. The cloud agent must use this instead of
 * calling the Anthropic SDK itself, so every review shares one rubric prefix.
 *
 *   npm run agent:vision-check -- --image tmp/figure.jpg --question-id <id>
 *   npm run agent:vision-check -- --image tmp/figure.jpg --question-file q.json
 *   npm run agent:vision-check -- --image tmp/figure.jpg --question-file q.json --peer-file peer.txt
 *
 * Prints JSON to stdout: { opus, sonnet, agree }. Peer notes are for a disagreement re-judge.
 * Requires ANTHROPIC_API_KEY or CLAUDE_API_KEY. --question-id also needs the agent API env.
 */
import * as fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { CLAUDE_OPUS, CLAUDE_SONNET_CURRENT } from "../../claudeModels";
import { agentRequest, configFromEnv } from "./questionAgentClient";
import { buildVisionRequest } from "./visionPrompt";

const MAX_EDGE = 1568;

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}

type Judgment = {
  pass: boolean;
  bodyPartMatch: boolean;
  lateralityMatch: boolean;
  modalityMatch: boolean;
  ageSexMatch: boolean;
  visibleTextLeak: boolean;
  multiPanel: boolean;
  summary: string;
  accepted: boolean;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
};

function asBool(value: unknown): boolean {
  return value === true;
}

export function judgmentFromText(raw: string, usage: Anthropic.Usage): Judgment {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const json = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const bodyPartMatch = asBool(json.bodyPartMatch);
  const lateralityMatch = asBool(json.lateralityMatch);
  const modalityMatch = asBool(json.modalityMatch);
  const ageSexMatch = asBool(json.ageSexMatch);
  const visibleTextLeak = asBool(json.visibleTextLeak);
  const multiPanel = asBool(json.multiPanel);
  const accepted =
    bodyPartMatch && lateralityMatch && modalityMatch && ageSexMatch && !visibleTextLeak && !multiPanel;
  return {
    pass: json.pass === true,
    bodyPartMatch,
    lateralityMatch,
    modalityMatch,
    ageSexMatch,
    visibleTextLeak,
    multiPanel,
    summary: String(json.summary ?? "").slice(0, 400),
    accepted,
    usage: {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens,
    },
  };
}

async function loadJpeg(imagePath: string): Promise<string> {
  const input = fs.readFileSync(imagePath);
  const out = await sharp(input)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return out.toString("base64");
}

async function loadQuestion(): Promise<{ question: string; answer: string }> {
  const file = arg("question-file");
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { question?: string; answer?: string };
    if (!parsed.question || !parsed.answer) throw new Error("--question-file must contain question and answer strings.");
    return { question: parsed.question, answer: parsed.answer };
  }
  const id = arg("question-id");
  if (!id) throw new Error("Pass --question-id or --question-file.");
  const res = await agentRequest(configFromEnv(), "GET", `/question/${encodeURIComponent(id)}`);
  if (res.status !== 200) throw new Error(`Could not load question ${id}: HTTP ${res.status}`);
  return { question: res.body.item.question, answer: res.body.item.answer };
}

async function judge(
  client: Anthropic,
  model: string,
  question: { question: string; answer: string },
  imageBase64: string,
  peerNotes: string | undefined
): Promise<Judgment> {
  const response = await client.messages.create(
    buildVisionRequest({
      model,
      question: question.question,
      answer: question.answer,
      imageBase64,
      peerNotes,
    })
  );
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return judgmentFromText(text, response.usage);
}

async function main() {
  const imagePath = arg("image");
  if (!imagePath) throw new Error("--image is required.");
  const apiKey = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY or CLAUDE_API_KEY.");
  const question = await loadQuestion();
  const peerFile = arg("peer-file");
  const peerNotes = peerFile ? fs.readFileSync(peerFile, "utf8") : undefined;
  const imageBase64 = await loadJpeg(imagePath);
  const client = new Anthropic({ apiKey });
  const opus = await judge(client, CLAUDE_OPUS, question, imageBase64, peerNotes);
  const sonnet = await judge(client, CLAUDE_SONNET_CURRENT, question, imageBase64, peerNotes);
  const result = { opus, sonnet, agree: opus.accepted === sonnet.accepted };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.includes("visionCheck")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
