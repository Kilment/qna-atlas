/**
 * Thin CLI for the question-fix cloud agent. It only talks HTTP to the production app;
 * it never touches a database.
 *
 *   QUESTION_AGENT_BASE_URL=https://prs-atlas.com QUESTION_AGENT_TOKEN=... \
 *   npm run agent:api -- queue [--category=reported,flagged,missing_media] [--specialty=prs] [--limit=20] [--offset=0]
 *   npm run agent:api -- question <questionId>
 *   npm run agent:api -- fix <file.json | -> [--dry-run]
 *   npm run agent:api -- image <file>
 *   npm run agent:api -- revert <revisionId> [--run-id=...] [--rationale="..."]
 *   npm run agent:api -- proposals [--status=pending] [--run-id=...] [--question-id=...]
 *   npm run agent:api -- new-run-id
 *
 * Exit code is non-zero on any non-2xx response (the response body is still printed).
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { agentRequest, configFromEnv } from "./questionAgentClient";

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("--"));
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) throw new Error("Usage: npm run agent:api -- <queue|question|fix|image|revert|proposals|new-run-id> ...");
  if (command === "new-run-id") {
    console.log(`run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
    return;
  }
  const cfg = configFromEnv();
  const pos = positional(rest);
  let result: { status: number; body: any };

  switch (command) {
    case "queue":
      result = await agentRequest(cfg, "GET", "/queue", {
        query: {
          category: flag(rest, "category"),
          specialty: flag(rest, "specialty"),
          limit: flag(rest, "limit"),
          offset: flag(rest, "offset"),
          includePending: flag(rest, "include-pending"),
        },
      });
      break;
    case "question":
      if (!pos[0]) throw new Error("question <questionId>");
      result = await agentRequest(cfg, "GET", `/question/${encodeURIComponent(pos[0])}`);
      break;
    case "fix": {
      if (!pos[0]) throw new Error("fix <file.json | ->");
      const raw = pos[0] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(pos[0], "utf8");
      result = await agentRequest(cfg, "POST", "/fix", {
        query: { dryRun: rest.includes("--dry-run") ? "true" : undefined },
        json: JSON.parse(raw),
      });
      break;
    }
    case "image": {
      if (!pos[0]) throw new Error("image <file>");
      const file = path.resolve(pos[0]);
      const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
      if (!mime) throw new Error("Image must be .jpg, .png, .webp or .gif");
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
      result = await agentRequest(cfg, "POST", "/image", { form });
      break;
    }
    case "revert":
      if (!pos[0]) throw new Error("revert <revisionId>");
      result = await agentRequest(cfg, "POST", "/revert", {
        json: { revisionId: pos[0], runId: flag(rest, "run-id"), rationale: flag(rest, "rationale") },
      });
      break;
    case "proposals":
      result = await agentRequest(cfg, "GET", "/proposals", {
        query: {
          status: flag(rest, "status"),
          runId: flag(rest, "run-id"),
          questionId: flag(rest, "question-id"),
          limit: flag(rest, "limit"),
        },
      });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  console.log(JSON.stringify(result.body, null, 2));
  if (result.status < 200 || result.status >= 300) {
    console.error(`HTTP ${result.status}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
