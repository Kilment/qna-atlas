/**
 * Claude API model ids that are safe to send.
 *
 * `claude-opus-4-1` is the dateless alias of `claude-opus-4-1-20250805`. Anthropic retired
 * that snapshot on August 5, 2026; requests fail with not_found_error and do not show on
 * the Usage page. The documented replacement is `claude-opus-4-8`.
 *
 * https://platform.claude.com/docs/en/about-claude/model-deprecations
 */

/** Official replacement for retired Claude Opus 4 and Opus 4.1. */
export const CLAUDE_OPUS = "claude-opus-4-8";

/** Official replacement for retired Claude Sonnet 4. */
export const CLAUDE_SONNET = "claude-sonnet-4-6";

/** Recommended replacement for deprecated Claude Sonnet 4.5. */
export const CLAUDE_SONNET_CURRENT = "claude-sonnet-5-5";

const RETIRED_CLAUDE_MODELS: Record<string, string> = {
  "claude-opus-4-1": CLAUDE_OPUS,
  "claude-opus-4-1-20250805": CLAUDE_OPUS,
  "claude-opus-4": CLAUDE_OPUS,
  "claude-opus-4-20250514": CLAUDE_OPUS,
  "claude-3-opus-20240229": CLAUDE_OPUS,
  "claude-sonnet-4": CLAUDE_SONNET,
  "claude-sonnet-4-20250514": CLAUDE_SONNET,
  "claude-3-7-sonnet-20250219": CLAUDE_SONNET,
  "claude-3-5-sonnet-20240620": CLAUDE_SONNET,
  "claude-3-5-sonnet-20241022": CLAUDE_SONNET,
  "claude-3-sonnet-20240229": CLAUDE_SONNET,
  "claude-sonnet-4-5": CLAUDE_SONNET_CURRENT,
  "claude-sonnet-4-5-20250929": CLAUDE_SONNET_CURRENT,
  "claude-3-haiku-20240307": "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
};

const warned = new Set<string>();

/** Use `fallback` when `requested` is empty. Rewrite retired ids before they hit the API. */
export function resolveClaudeModel(requested: string | undefined | null, fallback: string): string {
  const raw = (requested ?? "").trim();
  const chosen = raw || fallback;
  const replacement = RETIRED_CLAUDE_MODELS[chosen];
  if (!replacement || replacement === chosen) return chosen;
  if (!warned.has(chosen)) {
    warned.add(chosen);
    console.warn(`[claude] ${chosen} is not a current Claude API model; using ${replacement}`);
  }
  return replacement;
}

/**
 * Claude Opus 4.7 and later, including Opus 5, reject non-default temperature, top_p, and top_k.
 */
export function claudeRejectsSamplingParams(model: string): boolean {
  const opus4 = /^claude-opus-4-(\d+)/.exec(model);
  if (opus4) return Number(opus4[1]) >= 7;
  return (
    model.startsWith("claude-opus-5") ||
    model.startsWith("claude-fable-") ||
    model.startsWith("claude-mythos-")
  );
}

type SamplingFields = { temperature?: number; top_p?: number; top_k?: number };

/** Drop sampling fields the target model will reject with HTTP 400. */
export function withClaudeSampling<T extends SamplingFields>(model: string, params: T): T {
  if (!claudeRejectsSamplingParams(model)) return params;
  const { temperature: _temperature, top_p: _topP, top_k: _topK, ...rest } = params;
  return rest as T;
}
