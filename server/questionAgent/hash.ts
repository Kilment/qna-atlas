import { createHash } from "crypto";

/** Fingerprint of the live stem+answer; the agent echoes it back so stale writes are rejected. */
export function hashQuestion(question: string, answer: string): string {
  return createHash("sha256").update(`${question}\u0000${answer}`).digest("hex").slice(0, 32);
}
