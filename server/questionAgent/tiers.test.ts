import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyQuestionFix, isCosmeticEdit, stripMediaPhrases } from "../../shared/questionAgentTiers";
import { detectMediaPromise } from "../../shared/questionMediaHeuristics";
import { assessImageLicense } from "../../shared/imageLicense";

const Q = [
  "A 45-year-old woman smoker undergoes a breast reduction and develops nipple-areola complex necrosis. Which mechanism is most likely responsible?",
  "A. Nicotine-mediated vasoconstriction",
  "B. Pre-operative clot assessment",
  "C. Increased platelet aggregation",
  "D. Decreased hemoglobin level",
].join("\n");

const A =
  "A) Correct Answer: Nicotine-mediated vasoconstriction. Nicotine causes vasoconstriction that reduces dermal perfusion and is the main mechanism in smokers. The other options are less likely to explain the necrosis in this setting.";

const base = { previousQuestion: Q, previousAnswer: A };

describe("classifyQuestionFix", () => {
  it("reports unchanged text", () => {
    const r = classifyQuestionFix({ ...base, nextQuestion: Q, nextAnswer: A });
    assert.equal(r.unchanged, true);
    assert.equal(r.tier, "auto");
  });

  it("auto-applies explanation wording changes when the key is unchanged", () => {
    const r = classifyQuestionFix({
      ...base,
      nextQuestion: Q,
      nextAnswer: A.replace("The other options are less likely to explain the necrosis in this setting.", "Clot risk, platelet aggregation, and anemia contribute far less to necrosis after reduction in smokers."),
    });
    assert.equal(r.tier, "auto");
    assert.deepEqual(r.autoChanges, ["explanation"]);
  });

  it("auto-applies a typo fix in a choice and stem", () => {
    const r = classifyQuestionFix({
      ...base,
      nextQuestion: Q.replace("Nicotine-mediated", "Nicotine mediated").replace("mechanism is", "mechanism is"),
      nextAnswer: A,
    });
    assert.equal(r.tier, "auto");
  });

  it("requires approval when the keyed letter changes", () => {
    const r = classifyQuestionFix({ ...base, nextQuestion: Q, nextAnswer: A.replace(/^A\)/, "B)") });
    assert.equal(r.tier, "proposal");
    assert.match(r.reasons.join(" "), /key changed/i);
  });

  it("requires approval when a choice changes meaning even with high similarity", () => {
    const r = classifyQuestionFix({
      ...base,
      nextQuestion: Q.replace("Increased platelet aggregation", "Decreased platelet aggregation"),
      nextAnswer: A,
    });
    assert.equal(r.tier, "proposal");
  });

  it("requires approval when numbers change", () => {
    const q = Q.replace("45-year-old", "54-year-old");
    const r = classifyQuestionFix({ ...base, nextQuestion: q, nextAnswer: A });
    assert.equal(r.tier, "proposal");
  });

  it("requires approval when the stem is rewritten", () => {
    const r = classifyQuestionFix({
      ...base,
      nextQuestion: Q.replace(
        /^[^\n]+/,
        "A 30-year-old man with no history of clots on chronic steroids presents with delayed wound healing after abdominoplasty. Which supplement is most appropriate?"
      ),
      nextAnswer: A,
    });
    assert.equal(r.tier, "proposal");
    assert.match(r.reasons.join(" "), /stem/i);
  });

  it("requires approval when the number of choices changes", () => {
    const r = classifyQuestionFix({
      ...base,
      nextQuestion: `${Q}\nE. Venous congestion`,
      nextAnswer: A,
    });
    assert.equal(r.tier, "proposal");
  });

  it("requires approval for any image change or unhide request", () => {
    const img = classifyQuestionFix({ ...base, nextQuestion: Q, nextAnswer: A, hasImageChange: true });
    assert.equal(img.tier, "proposal");
    const unhide = classifyQuestionFix({ ...base, nextQuestion: Q, nextAnswer: A, wantsUnhide: true });
    assert.equal(unhide.tier, "proposal");
  });

  it("auto-applies removing a photograph-is-shown phrase and nothing else", () => {
    const withPhrase = Q.replace(/^/, "A photograph is shown. ");
    const r = classifyQuestionFix({
      previousQuestion: withPhrase,
      previousAnswer: A,
      nextQuestion: Q,
      nextAnswer: A,
    });
    assert.equal(r.tier, "auto");
    assert.deepEqual(r.autoChanges, ["stem_media_phrase_removed"]);
  });

  it("flags drastic explanation shortening", () => {
    const r = classifyQuestionFix({ ...base, nextQuestion: Q, nextAnswer: "A) Correct Answer: Nicotine." });
    assert.equal(r.tier, "proposal");
  });
});

describe("helpers", () => {
  it("isCosmeticEdit tolerates punctuation and case only", () => {
    assert.equal(isCosmeticEdit("Free flap loss", "Free-flap loss."), true);
    assert.equal(isCosmeticEdit("within 1 cm", "within 2 cm"), false);
    assert.equal(isCosmeticEdit("no history of clots", "history of clots"), false);
  });
  it("stripMediaPhrases removes shown phrases", () => {
    assert.equal(stripMediaPhrases("A clinical photograph is shown. What is next?"), "What is next?");
  });
});

describe("detectMediaPromise", () => {
  it("finds promised photos, imaging, and labs without values", () => {
    assert.equal(detectMediaPromise("A photograph is shown. What is the diagnosis?\nA. x\nB. y", false)?.kind, "photo");
    assert.equal(detectMediaPromise("A radiograph is provided. What is the fracture?\nA. x\nB. y", false)?.kind, "imaging");
    assert.equal(detectMediaPromise("Laboratory values are shown below. What is next?\nA. x\nB. y", false)?.kind, "labs");
  });
  it("ignores labs when values follow and when an image is attached", () => {
    assert.equal(detectMediaPromise("Laboratory values are: Hgb 8.2, Plt 90. What is next?\nA. x\nB. y", false), null);
    assert.equal(detectMediaPromise("A photograph is shown. Diagnosis?\nA. x\nB. y", true), null);
  });
  it("does not flag ordinary descriptive stems", () => {
    assert.equal(detectMediaPromise("A 30-year-old has an MRI showing a mass. Next step?\nA. x\nB. y", false), null);
  });
});

describe("assessImageLicense", () => {
  it("allows commercial-friendly licenses", () => {
    assert.equal(assessImageLicense("cc by").canonical, "CC BY");
    assert.equal(assessImageLicense("CC BY 4.0").canonical, "CC BY 4.0");
    assert.equal(assessImageLicense("cc by-sa").canonical, "CC BY-SA");
    assert.equal(assessImageLicense("cc0").canonical, "CC0");
    assert.equal(assessImageLicense("http://creativecommons.org/licenses/by/4.0/").canonical, "CC BY 4.0");
    assert.equal(assessImageLicense("http://creativecommons.org/publicdomain/zero/1.0/").canonical, "CC0");
  });
  it("rejects NC, ND, unknown and empty", () => {
    for (const l of ["cc by-nc", "CC BY-NC-ND 4.0", "cc by-nd", "http://creativecommons.org/licenses/by-nc/4.0/", "all rights reserved", "", null]) {
      assert.equal(assessImageLicense(l as string | null).allowed, false, String(l));
    }
  });
});
