import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairMojibake, looksLikeMojibake } from "@shared/textEncoding";

const macDecode = new TextDecoder("macintosh");

/** What the corruption does: UTF-8 bytes read as MacRoman. */
function corrupt(s: string): string {
  return macDecode.decode(Buffer.from(s, "utf-8"));
}

describe("repairMojibake", () => {
  it("round-trips clean MacRoman mojibake for the characters seen in the bank", () => {
    for (const s of ["0\u20134 weeks", "5 \u00d7 8 mm", "patient\u2019s", "\u201cquoted\u201d", "40\u00b0C", "\u20ac5", "caf\u00e9", "Br\u00fcck", "Pfizer\u00ae", "\u2122", "\u00a7 3", "\u2014"]) {
      assert.equal(repairMojibake(corrupt(s)), s, s);
    }
  });

  it("leaves clean text alone", () => {
    const s = "A 45-year-old man (5\u20138 weeks, 6 \u00d7 11 mm) with patient\u2019s \u201cbags\u201d.";
    assert.equal(repairMojibake(s), s);
    assert.equal(repairMojibake("plain ascii, 1 x 2 cm"), "plain ascii, 1 x 2 cm");
    assert.equal(looksLikeMojibake(s), false);
  });

  it("repairs the accent-stripped variants using context", () => {
    assert.equal(repairMojibake("reconstruction of a 6 \u221ao 11-mm defect"), "reconstruction of a 6 \u00d7 11-mm defect");
    assert.equal(repairMojibake("a 35 \u221ao 25 cm flap"), "a 35 \u00d7 25 cm flap");
    assert.equal(repairMojibake("5\u201a\u00c4i8 weeks"), "5\u20138 weeks");
    assert.equal(repairMojibake("intervention\u201a\u00c4ionly"), "intervention\u2014only");
    assert.equal(repairMojibake("Part I \u201a\u00c4i Basic Science"), "Part I \u2013 Basic Science");
    assert.equal(repairMojibake("the patient\u201a\u00c4os chart"), "the patient\u2019s chart");
    assert.equal(repairMojibake("a \u201a\u00c4ukite\u201a\u00c4u flap"), "a \u201ckite\u201d flap");
    assert.equal(repairMojibake("\u201a\u00c4uOpening\u201a\u00c4u text"), "\u201cOpening\u201d text");
  });

  it("repairs double mojibake (Windows-1252 then MacRoman) with lost prefix/accent", () => {
    assert.equal(repairMojibake("Green \u201a\u00c7\u00a8\u201a\u00d1\u00a2s Operative Hand Surgery"), "Green \u2019s Operative Hand Surgery");
    assert.equal(repairMojibake("Cryotherapy \u201a\u00c7\u00a8\u201a\u00c4u7.5%"), "Cryotherapy \u20137.5%");
    assert.equal(repairMojibake("Cryotherapy \u221a\u00a2\u201a\u00c7\u00a8\u201a\u00c4\u00fa7.5%"), "Cryotherapy \u20137.5%");
  });

  it("handles several stripped dashes in one string", () => {
    assert.equal(
      repairMojibake("A) 0\u201a\u00c4i4 weeks B) 5\u201a\u00c4i8 weeks C) 9\u201a\u00c4i13 weeks D) 14\u201a\u00c4i18 weeks"),
      "A) 0\u20134 weeks B) 5\u20138 weeks C) 9\u201313 weeks D) 14\u201318 weeks",
    );
  });

  it("uses en dashes for hyphenated compounds and em dashes for asides", () => {
    assert.equal(repairMojibake("right-hand\u201a\u00c4idominant man"), "right-hand\u2013dominant man");
    assert.equal(repairMojibake("the intervention\u201a\u00c4ionly that"), "the intervention\u2014only that");
  });

  it("does not touch legitimate square roots or bare x", () => {
    assert.equal(repairMojibake("value \u221a2 is irrational"), "value \u221a2 is irrational");
  });

  it("flags text that still looks corrupted", () => {
    assert.equal(looksLikeMojibake("5\u201a\u00c4i8"), true);
  });
});

import { decodeHtmlEntities } from "@shared/questionImport";
describe("import path", () => {
  it("repairs mojibake before the import normalisation strips accents", () => {
    assert.equal(decodeHtmlEntities("a 6 \u00d7 11 mm flap, 5\u20138 weeks"), "a 6 \u00d7 11 mm flap, 5\u20138 weeks".replace(/\u00d7/g, "\u00d7"));
    const damaged = macDecode.decode(Buffer.from("5\u20138 weeks and the patient\u2019s 6 \u00d7 11 mm flap", "utf-8"));
    const out = decodeHtmlEntities(damaged);
    assert.ok(!/[\u201a\u221a]/.test(out), out);
    assert.match(out, /5\u20138 weeks/);
    assert.match(out, /6 \u00d7 11 mm/);
  });
});
