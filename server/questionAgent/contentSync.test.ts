/**
 * Content promotion and snapshot tests.
 * The import tests use DATABASE_URL (the workspace DB) with throwaway section/question rows that
 * are deleted afterwards; they are skipped when DATABASE_URL is not set.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_FILE_FORMAT,
  computeContentHash,
  importSpecialtyContent,
  type ContentQuestion,
  type SpecialtyContentFile,
} from "../content/specialtyContent";
import { diffContent, validateSnapshot } from "./snapshot";

const SUFFIX = Math.random().toString(36).slice(2, 8);
const SEC = `zz-sync-sec-${SUFFIX}`;
const SUB = `zz-sync-sub-${SUFFIX}`;
const QID = `zz-sync-q-${SUFFIX}`;

function makeFile(q: Partial<ContentQuestion>): SpecialtyContentFile {
  const sections = [{ id: SEC, specialtyId: "prs" as const, title: "Sync test", sortOrder: 9999 }];
  const subsections = [{ id: SUB, sectionId: SEC, title: "Sync test sub", sortOrder: 9999 }];
  const questions: ContentQuestion[] = [
    {
      id: QID,
      subsectionId: SUB,
      question: "Stem?\nA) one\nB) two",
      answer: "A)\nBecause.",
      tags: [],
      source: "imported",
      visible: true,
      reported: false,
      flagged: false,
      imageUrl: null,
      imageAlt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...q,
    },
  ];
  return {
    formatVersion: CONTENT_FILE_FORMAT,
    specialtyId: "prs",
    exportedAt: new Date().toISOString(),
    sourceFingerprint: "test",
    contentHash: computeContentHash({ sections, subsections, questions }),
    counts: { sections: 1, subsections: 1, questions: 1 },
    sections,
    subsections,
    questions,
  };
}

describe("snapshot helpers", () => {
  it("validates hash and shape", () => {
    const file = makeFile({});
    assert.deepEqual(validateSnapshot(file, "prs"), []);
    assert.ok(validateSnapshot(file, "ortho").length > 0);
    const tampered = { ...file, questions: [{ ...file.questions[0], answer: "changed" }] };
    assert.match(validateSnapshot(tampered, "prs").join(" "), /hash/);
  });
  it("counts added, removed, text, visibility and image changes", () => {
    const a = makeFile({});
    const b = makeFile({ answer: "B)\nNew", visible: false, imageUrl: "/question-images/x.jpg" });
    assert.deepEqual(diffContent(a, b), { added: 0, removed: 0, textChanged: 1, visibilityChanged: 1, imageChanged: 1 });
    assert.equal(diffContent(null, a).added, 1);
    assert.equal(diffContent(a, { ...a, questions: [] }).removed, 1);
  });
});

describe("insert-only promotion is last-writer-wins", { skip: !process.env.DATABASE_URL }, () => {
  let pool: import("pg").Pool;

  const row = async () =>
    (await pool.query(`SELECT * FROM questions WHERE id = $1`, [QID])).rows[0];

  before(async () => {
    pool = (await import("../db")).pool;
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM questions WHERE id = $1`, [QID]);
      await pool.query(`DELETE FROM subsections WHERE id = $1`, [SUB]);
      await pool.query(`DELETE FROM sections WHERE id = $1`, [SEC]);
      await pool.end();
    }
  });

  it("inserts new questions including image attribution", async () => {
    await importSpecialtyContent(
      pool,
      makeFile({
        imageUrl: "/question-images/agent/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
        imageAlt: "Alt",
        imageSourcePmcid: "PMC1234567",
        imageCredit: "Doe J et al.",
        imageLicense: "CC BY",
        imageSourceUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/",
      })
    );
    const r = await row();
    assert.equal(r.image_credit, "Doe J et al.");
    assert.equal(r.image_license, "CC BY");
    assert.equal(r.image_source_pmcid, "PMC1234567");
    assert.equal(r.visible, true);
  });

  it("does not let a stale content file revert a newer production edit", async () => {
    // Production row edited "later" (the agent attached/kept an image and unhid the question).
    await pool.query(`UPDATE questions SET updated_at = '2026-06-01T00:00:00Z', visible = true, flagged = false WHERE id = $1`, [QID]);
    await importSpecialtyContent(
      pool,
      makeFile({ visible: false, flagged: true, imageUrl: null, imageAlt: null, updatedAt: "2026-02-01T00:00:00.000Z" })
    );
    const r = await row();
    assert.equal(r.visible, true, "newer production visibility must win");
    assert.equal(r.flagged, false);
    assert.match(r.image_url, /question-images\/agent\//, "newer production image must survive");
    assert.equal(r.image_credit, "Doe J et al.");
  });

  it("still applies a newer workspace flag and never rewrites wording in insert-only mode", async () => {
    await importSpecialtyContent(
      pool,
      makeFile({
        visible: false,
        flagged: true,
        question: "Different stem?\nA) x\nB) y",
        answer: "B)\nOther.",
        updatedAt: "2026-09-01T00:00:00.000Z",
      })
    );
    const r = await row();
    assert.equal(r.flagged, true);
    assert.equal(r.visible, false);
    assert.equal(r.question, "Stem?\nA) one\nB) two");
  });

  it("upsert mode overwrites wording", async () => {
    await importSpecialtyContent(
      pool,
      makeFile({ question: "Different stem?\nA) x\nB) y", answer: "B)\nOther.", updatedAt: "2026-09-02T00:00:00.000Z" }),
      { mode: "upsert" }
    );
    assert.equal((await row()).question, "Different stem?\nA) x\nB) y");
  });
});
