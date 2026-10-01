/**
 * Explicit prompt-cache breakpoints for repeated Claude prefixes.
 *
 * Top-level `cache_control` is the wrong tool for these calls. It marks the last
 * block, and that block is the per-request question or image, so the prefix hash
 * never matches a previous write. Mark the last block that stays identical instead.
 * Writes happen only at breakpoints; a short system prompt under the model minimum
 * (512 tokens on Opus 5.5 and Sonnet 5.5, 1024 on Sonnet 4.6) is ignored, not billed.
 *
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ClaudeCacheTtl = "5m" | "1h";

/** Ephemeral cache breakpoint. Omit `ttl` for the 5-minute default, which refreshes for free on each hit. */
export function claudeCacheControl(ttl?: ClaudeCacheTtl): Anthropic.CacheControlEphemeral {
  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

/**
 * System prompt as a single cached block.
 * Use `1h` when the same instructions are reused by a long-running agent that may pause more than 5 minutes.
 * Batch jobs that call back-to-back should keep the 5-minute default.
 */
export function cachedSystem(text: string, ttl?: ClaudeCacheTtl): Anthropic.TextBlockParam[] {
  const block: Anthropic.TextBlockParam = { type: "text", text };
  if (text.trim()) block.cache_control = claudeCacheControl(ttl);
  return [block];
}

/**
 * User turn with the stable instructions cached and the varying payload after the breakpoint.
 * An empty stable prefix is omitted so we never send an empty cached block.
 */
export function userContentWithCachedPrefix(
  stable: string,
  varying: string,
  ttl?: ClaudeCacheTtl
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  if (stable.trim()) {
    blocks.push({ type: "text", text: stable, cache_control: claudeCacheControl(ttl) });
  }
  if (varying.length > 0 || blocks.length === 0) {
    blocks.push({ type: "text", text: varying });
  }
  return blocks;
}
