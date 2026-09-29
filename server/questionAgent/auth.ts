/**
 * Auth helpers for the question-fix cloud agent.
 *
 * Two separate secrets on purpose:
 *  - QUESTION_AGENT_TOKEN: held by the cloud agent; lets it read the queue and file fixes/proposals.
 *  - QUESTION_AGENT_APPROVAL_SECRET: held only by the production app; signs the Slack review links
 *    that approve proposals. The agent never sees it, so it cannot approve its own proposals.
 */
import { createHmac, timingSafeEqual } from "crypto";

const MIN_SECRET_LENGTH = 24;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function questionAgentTokenConfigured(): boolean {
  return (process.env.QUESTION_AGENT_TOKEN?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

/** True when the request carries the cloud agent token (Authorization: Bearer or X-Question-Agent-Token). */
export function requireQuestionAgentToken(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const expected = process.env.QUESTION_AGENT_TOKEN?.trim() ?? "";
  if (expected.length < MIN_SECRET_LENGTH) return false;
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerRaw = req.headers["x-question-agent-token"];
  const header = typeof headerRaw === "string" ? headerRaw.trim() : "";
  return (bearer !== "" && safeEqual(bearer, expected)) || (header !== "" && safeEqual(header, expected));
}

export function approvalSecret(): string | null {
  const s = process.env.QUESTION_AGENT_APPROVAL_SECRET?.trim() ?? "";
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

export const REVIEW_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signaturePayload(proposalId: string, expiresAt: number): string {
  return `question-agent-review:${proposalId}:${expiresAt}`;
}

export function signReviewLink(
  proposalId: string,
  expiresAt: number,
  secret: string | null = approvalSecret()
): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(signaturePayload(proposalId, expiresAt)).digest("hex");
}

export function verifyReviewSignature(
  proposalId: string,
  expiresAt: number,
  sig: string,
  now: number = Date.now(),
  secret: string | null = approvalSecret()
): boolean {
  if (!secret || !Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = signReviewLink(proposalId, expiresAt, secret);
  if (!expected || typeof sig !== "string") return false;
  return safeEqual(sig, expected);
}

/** Absolute review URL for Slack, or null if no approval secret / origin is configured. */
export function buildReviewUrl(proposalId: string, now: number = Date.now()): string | null {
  const expiresAt = now + REVIEW_LINK_TTL_MS;
  const sig = signReviewLink(proposalId, expiresAt);
  if (!sig) return null;
  const origin = (process.env.CANONICAL_PUBLIC_ORIGIN?.trim() || "").replace(/\/+$/, "");
  const path = `/api/question-agent/review/${encodeURIComponent(proposalId)}?exp=${expiresAt}&sig=${sig}`;
  return origin ? `${origin}${path}` : path;
}
