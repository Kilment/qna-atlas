import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewUrl,
  requireQuestionAgentToken,
  signReviewLink,
  verifyReviewSignature,
} from "./auth";
import { AGENT_IMAGE_FILE_RE, sniffImageMime } from "./imageBucket";

const TOKEN = "t".repeat(32);
const SECRET = "s".repeat(32);
const saved = { ...process.env };

beforeEach(() => {
  process.env.QUESTION_AGENT_TOKEN = TOKEN;
  process.env.QUESTION_AGENT_APPROVAL_SECRET = SECRET;
  process.env.CANONICAL_PUBLIC_ORIGIN = "https://example.test";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("requireQuestionAgentToken", () => {
  it("accepts the bearer token and the header token", () => {
    assert.equal(requireQuestionAgentToken({ headers: { authorization: `Bearer ${TOKEN}` } }), true);
    assert.equal(requireQuestionAgentToken({ headers: { "x-question-agent-token": TOKEN } }), true);
  });
  it("rejects wrong, missing, and short configured tokens", () => {
    assert.equal(requireQuestionAgentToken({ headers: { authorization: "Bearer nope" } }), false);
    assert.equal(requireQuestionAgentToken({ headers: {} }), false);
    process.env.QUESTION_AGENT_TOKEN = "short";
    assert.equal(requireQuestionAgentToken({ headers: { authorization: "Bearer short" } }), false);
    delete process.env.QUESTION_AGENT_TOKEN;
    assert.equal(requireQuestionAgentToken({ headers: { authorization: "Bearer " } }), false);
  });
  it("does not accept the approval secret as an agent token", () => {
    assert.equal(requireQuestionAgentToken({ headers: { authorization: `Bearer ${SECRET}` } }), false);
  });
});

describe("review link signatures", () => {
  it("verifies a good signature and rejects tampering and expiry", () => {
    const exp = Date.now() + 60_000;
    const sig = signReviewLink("abc", exp)!;
    assert.equal(verifyReviewSignature("abc", exp, sig), true);
    assert.equal(verifyReviewSignature("abd", exp, sig), false);
    assert.equal(verifyReviewSignature("abc", exp + 1, sig), false);
    assert.equal(verifyReviewSignature("abc", exp, "0".repeat(64)), false);
    assert.equal(verifyReviewSignature("abc", Date.now() - 1, signReviewLink("abc", Date.now() - 1)!), false);
  });
  it("cannot be signed without an approval secret", () => {
    delete process.env.QUESTION_AGENT_APPROVAL_SECRET;
    assert.equal(signReviewLink("abc", Date.now() + 1000), null);
    assert.equal(buildReviewUrl("abc"), null);
  });
  it("builds an absolute URL", () => {
    const url = buildReviewUrl("abc")!;
    assert.match(url, /^https:\/\/example\.test\/api\/question-agent\/review\/abc\?exp=\d+&sig=[0-9a-f]{64}$/);
  });
});

describe("image helpers", () => {
  it("sniffs real image bytes and rejects others", () => {
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
    assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniffImageMime(Buffer.from("GIF89a....")), "image/gif");
  });
  it("only serves generated file names", () => {
    assert.equal(AGENT_IMAGE_FILE_RE.test("3f2b6c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.jpg"), true);
    assert.equal(AGENT_IMAGE_FILE_RE.test("../secret.jpg"), false);
    assert.equal(AGENT_IMAGE_FILE_RE.test("3f2b6c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.svg"), false);
  });
});
