import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedSystem, userContentWithCachedPrefix } from "./claudePromptCache";
import { VISION_SYSTEM_PROMPT, buildVisionRequest } from "./scripts/agent/visionPrompt";
import { judgmentFromText } from "./scripts/agent/visionCheck";

describe("cachedSystem", () => {
  it("puts the breakpoint on the system block, not on a later varying block", () => {
    const system = cachedSystem("Shared editorial rules.");
    assert.equal(system.length, 1);
    assert.equal(system[0].type, "text");
    assert.equal(system[0].text, "Shared editorial rules.");
    assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
  });

  it("uses a 1-hour breakpoint only when asked", () => {
    const system = cachedSystem("Shared rubric.", "1h");
    assert.deepEqual(system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  });

  it("does not mark an empty system block as cacheable", () => {
    const system = cachedSystem("  ");
    assert.equal(system[0].cache_control, undefined);
  });
});

describe("userContentWithCachedPrefix", () => {
  it("caches the stable instructions and leaves the per-request payload unmarked", () => {
    const blocks = userContentWithCachedPrefix("Format rules that never change.", "Question 1 payload");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].cache_control?.type, "ephemeral");
    assert.equal(blocks[0].text, "Format rules that never change.");
    assert.equal(blocks[1].cache_control, undefined);
    assert.equal(blocks[1].text, "Question 1 payload");
  });

  it("keeps the cached prefix identical when only the payload changes", () => {
    const first = userContentWithCachedPrefix("Same rules.", "item A");
    const second = userContentWithCachedPrefix("Same rules.", "item B");
    assert.deepEqual(first[0], second[0]);
    assert.notEqual(first[1].text, second[1].text);
  });

  it("omits an empty stable prefix", () => {
    const blocks = userContentWithCachedPrefix("  ", "only the question");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].cache_control, undefined);
    assert.equal(blocks[0].text, "only the question");
  });
});

describe("buildVisionRequest", () => {
  it("caches the shared rubric for an hour and the question for five minutes, with the image last", () => {
    const params = buildVisionRequest({
      model: "claude-opus-5-5",
      question: "Stem\nA) one",
      answer: "A)\nbecause",
      imageBase64: "aW1hZ2U=",
      peerNotes: "The other model rejected laterality.",
    });
    assert.equal("cache_control" in params, false);
    assert.equal("temperature" in params, false);
    assert.equal("top_p" in params, false);
    assert.equal("top_k" in params, false);

    const system = params.system;
    assert.ok(Array.isArray(system));
    assert.equal(system[0].cache_control?.ttl, "1h");
    assert.equal(system[0].text, VISION_SYSTEM_PROMPT);
    // Opus 5.5 and Sonnet 5.5 ignore breakpoints under 512 tokens. This rubric is the shared prefix.
    assert.ok(VISION_SYSTEM_PROMPT.length >= 2400, `rubric length ${VISION_SYSTEM_PROMPT.length}`);

    const content = params.messages[0].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "text");
    assert.equal(content[0].cache_control?.type, "ephemeral");
    assert.equal(content[0].cache_control?.ttl, undefined);
    assert.match(content[0].text, /Stem/);
    assert.equal(content[1].type, "text");
    assert.equal(content[1].cache_control, undefined);
    assert.match(content[1].text, /other model rejected laterality/);
    assert.equal(content[2].type, "image");

    const secondImage = buildVisionRequest({
      model: "claude-opus-5-5",
      question: "Stem\nA) one",
      answer: "A)\nbecause",
      imageBase64: "b3RoZXI=",
    });
    const secondContent = secondImage.messages[0].content;
    assert.ok(Array.isArray(secondContent));
    assert.deepEqual(secondContent[0], content[0]);
    assert.equal(secondContent[1].type, "image");
    assert.deepEqual(secondImage.system, params.system);
  });

  it("accepts a figure only when every visual check passes", () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 400,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    };
    const leak = judgmentFromText(
      '{"pass": true, "bodyPartMatch": true, "lateralityMatch": true, "modalityMatch": true, "ageSexMatch": true, "visibleTextLeak": true, "multiPanel": false, "summary": "label names the diagnosis"}',
      usage
    );
    assert.equal(leak.accepted, false);
    assert.equal(leak.usage.cache_read_input_tokens, 400);
    const ok = judgmentFromText(
      '{"pass": true, "bodyPartMatch": true, "lateralityMatch": true, "modalityMatch": true, "ageSexMatch": true, "visibleTextLeak": false, "multiPanel": false, "summary": "matches"}',
      usage
    );
    assert.equal(ok.accepted, true);
  });
});
