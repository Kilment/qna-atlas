import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  CLAUDE_SONNET_CURRENT,
  claudeRejectsSamplingParams,
  resolveClaudeModel,
  withClaudeSampling,
} from "./claudeModels";

describe("resolveClaudeModel", () => {
  it("rewrites the retired Opus 4.1 alias and dated snapshot", () => {
    assert.equal(resolveClaudeModel("claude-opus-4-1", "claude-opus-5"), CLAUDE_OPUS);
    assert.equal(resolveClaudeModel("claude-opus-4-1-20250805", "claude-opus-5"), CLAUDE_OPUS);
  });

  it("rewrites other retired Claude ids to the documented replacement", () => {
    assert.equal(resolveClaudeModel("claude-opus-4-20250514", CLAUDE_OPUS), CLAUDE_OPUS);
    assert.equal(resolveClaudeModel("claude-sonnet-4-20250514", CLAUDE_SONNET), CLAUDE_SONNET);
    assert.equal(resolveClaudeModel("claude-sonnet-4-5", CLAUDE_SONNET), CLAUDE_SONNET_CURRENT);
  });

  it("keeps active model ids and uses the fallback when unset", () => {
    assert.equal(resolveClaudeModel("claude-opus-5", CLAUDE_OPUS), "claude-opus-5");
    assert.equal(resolveClaudeModel("claude-opus-4-6", CLAUDE_OPUS), "claude-opus-4-6");
    assert.equal(resolveClaudeModel("  ", "claude-opus-5"), "claude-opus-5");
    assert.equal(resolveClaudeModel(undefined, "claude-opus-5"), "claude-opus-5");
  });
});

describe("claude sampling params", () => {
  it("drops temperature on Opus 4.7 and later", () => {
    assert.equal(claudeRejectsSamplingParams("claude-opus-4-8"), true);
    assert.equal(claudeRejectsSamplingParams("claude-opus-5"), true);
    assert.equal(claudeRejectsSamplingParams("claude-opus-4-6"), false);
    assert.equal(claudeRejectsSamplingParams("claude-sonnet-4-6"), false);
    const sent = withClaudeSampling("claude-opus-4-8", {
      model: "claude-opus-4-8",
      temperature: 0.4,
      max_tokens: 100,
    });
    assert.equal("temperature" in sent, false);
    assert.equal(sent.max_tokens, 100);
  });
});
