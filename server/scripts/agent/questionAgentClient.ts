/**
 * HTTP client for the question-fix agent API (shared by the CLI and other agent scripts).
 * It only talks HTTP to the production app; it never touches a database.
 */
export interface AgentApiConfig {
  baseUrl: string;
  token: string;
}

export function configFromEnv(): AgentApiConfig {
  const baseUrl = (process.env.QUESTION_AGENT_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.QUESTION_AGENT_TOKEN ?? "").trim();
  if (!baseUrl) throw new Error("QUESTION_AGENT_BASE_URL is required (for example https://prs-atlas.com).");
  if (!token) throw new Error("QUESTION_AGENT_TOKEN is required.");
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
    throw new Error("QUESTION_AGENT_BASE_URL must be https (http is only allowed for localhost).");
  }
  return { baseUrl, token };
}

export async function agentRequest(
  cfg: AgentApiConfig,
  method: "GET" | "POST",
  apiPath: string,
  options: { query?: Record<string, string | undefined>; json?: unknown; form?: FormData } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(`${cfg.baseUrl}/api/internal/question-agent${apiPath}`);
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  let body: RequestInit["body"];
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body: parsed };
}

