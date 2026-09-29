/**
 * Integration test for the question-fix agent API. Uses DATABASE_URL (the workspace database),
 * inserts one throwaway hidden question, exercises every endpoint through a real Express app, and
 * cleans up after itself. Skipped when DATABASE_URL is not set. Slack is disabled for the run.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const TOKEN = "k".repeat(40);
const SECRET = "z".repeat(40);
process.env.QUESTION_AGENT_TOKEN = TOKEN;
process.env.QUESTION_AGENT_APPROVAL_SECRET = SECRET;
process.env.CANONICAL_PUBLIC_ORIGIN = "http://localhost";
process.env.QUESTION_AGENT_MAX_AUTO_PER_RUN = "2";
process.env.QUESTION_AGENT_IMAGE_DRIVER = "local";
for (const k of [
  "SLACK_WEBHOOK_URL",
  "SLACK_QUESTION_REPORTS_WEBHOOK_URL",
  "SLACK_QUESTION_AGENT_WEBHOOK_URL",
  "SLACK_SUPPORT_WEBHOOK_URL",
]) {
  process.env[k] = "";
}

const hasDb = !!process.env.DATABASE_URL;
const QID = `zz-agent-test-${Math.random().toString(36).slice(2, 10)}`;
const SRC = `zz-agent-src-${Math.random().toString(36).slice(2, 10)}`;
const RUN = `test-run-${Math.random().toString(36).slice(2, 10)}`;

const QUESTION = [
  "A 45-year-old woman smoker undergoes a breast reduction and develops nipple-areola complex necrosis. Which mechanism is most likely responsible?",
  "A) Nicotine-mediated vasoconstriction",
  "B) Pre-operative clot assessment",
  "C) Increased platelet aggregation",
  "D) Decreased hemoglobin level",
].join("\n");
const ANSWER =
  "A)\nNicotine-mediated vasoconstriction is the correct answer. Nicotine reduces dermal perfusion and is the dominant mechanism in smokers. The other options are less likely to explain necrosis in this setting.";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("question agent API", { skip: !hasDb }, () => {
  let server: Server;
  let base = "";
  let pool: import("pg").Pool;
  let uploadedFiles: string[] = [];

  const call = async (method: string, url: string, body?: unknown, auth = true) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // html or empty
    }
    return { status: res.status, json };
  };
  const fix = (body: Record<string, unknown>, query = "") =>
    call("POST", `/api/internal/question-agent/fix${query}`, { questionId: QID, runId: RUN, ...body });
  const reviewHtml = async (proposalId: string) => {
    const { signReviewLink } = await import("./auth");
    const exp = Date.now() + 60_000;
    const sig = signReviewLink(proposalId, exp)!;
    const page = await fetch(`${base}/api/question-agent/review/${proposalId}?exp=${exp}&sig=${sig}`);
    assert.equal(page.status, 200);
    return page.text();
  };
  const current = async () => (await pool.query(`SELECT * FROM questions WHERE id = $1`, [QID])).rows[0];
  const getItem = async () => (await call("GET", `/api/internal/question-agent/question/${encodeURIComponent(QID)}`)).json;

  before(async () => {
    const express = (await import("express")).default;
    const dbMod = await import("../db");
    pool = dbMod.pool;
    const { storage } = await import("../storage");
    await storage.ensureQuestionAgentSchema();
    const { registerQuestionAgentRoutes } = await import("./routes");
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    registerQuestionAgentRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sub = await pool.query(`SELECT id FROM subsections ORDER BY id LIMIT 1`);
    await pool.query(
      `INSERT INTO questions (id, subsection_id, question, answer, tags, source, visible) VALUES ($1,$2,$3,$4,'[]'::jsonb,'imported',false)`,
      [QID, sub.rows[0].id, QUESTION, ANSWER]
    );
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM question_agent_proposals WHERE question_id = ANY($1)`, [[QID, SRC]]);
      await pool.query(`DELETE FROM question_revisions WHERE question_id = ANY($1)`, [[QID, SRC]]);
      await pool.query(`DELETE FROM questions WHERE id = ANY($1)`, [[QID, SRC]]);
    }
    for (const f of uploadedFiles) {
      fs.rmSync(path.join(process.cwd(), "server/data/agent-images", f), { force: true });
    }
    await new Promise((r) => server?.close(r));
    if (pool) await pool.end();
  });

  it("hides the API from callers without the token", async () => {
    assert.equal((await call("GET", "/api/internal/question-agent/queue", undefined, false)).status, 404);
    const bad = await fetch(`${base}/api/internal/question-agent/queue`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(bad.status, 404);
  });

  it("lists the throwaway question in the flagged/hidden queue", async () => {
    const { status, json } = await call("GET", "/api/internal/question-agent/queue?category=flagged&limit=50");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items));
    assert.ok(json.total >= 1);
    const item = await getItem();
    assert.equal(item.item.id, QID);
    assert.match(item.item.baseHash, /^[0-9a-f]{32}$/);
  });

  it("requires baseHash, runId and rationale", async () => {
    const noHash = await fix({ rationale: "x", question: QUESTION, answer: ANSWER });
    assert.equal(noHash.status, 400);
    const noRun = await call("POST", "/api/internal/question-agent/fix", { questionId: QID, rationale: "x", baseHash: "a" });
    assert.equal(noRun.status, 400);
    const noWhy = await fix({ baseHash: "a" });
    assert.equal(noWhy.status, 400);
  });

  it("rejects stale writes", async () => {
    const r = await fix({ baseHash: "0".repeat(32), rationale: "typo", question: QUESTION, answer: ANSWER });
    assert.equal(r.status, 409);
    assert.equal(r.json.status, "stale");
  });

  it("rejects invalid format", async () => {
    const hash = (await getItem()).item.baseHash;
    const r = await fix({ baseHash: hash, rationale: "bad", question: "No choices here", answer: "nothing" });
    assert.equal(r.status, 400);
    assert.equal(r.json.status, "invalid");
  });

  it("dry run classifies without writing", async () => {
    const hash = (await getItem()).item.baseHash;
    const newAnswer = ANSWER.replace("dominant mechanism", "main mechanism");
    const r = await fix({ baseHash: hash, rationale: "wording", question: QUESTION, answer: newAnswer }, "?dryRun=true");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "dry_run");
    assert.equal(r.json.tier, "auto");
    assert.equal((await current()).answer, ANSWER);
  });

  let autoRevisionId = "";
  it("auto-applies a safe explanation edit and records a revision", async () => {
    const hash = (await getItem()).item.baseHash;
    const newAnswer = ANSWER.replace("dominant mechanism", "main mechanism");
    const r = await fix({ baseHash: hash, rationale: "wording", question: QUESTION, answer: newAnswer });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "applied");
    autoRevisionId = r.json.revisionId;
    assert.equal((await current()).answer, newAnswer);
    const rev = (await pool.query(`SELECT source, run_id, previous_answer FROM question_revisions WHERE id = $1`, [autoRevisionId])).rows[0];
    assert.equal(rev.source, "cloud_agent");
    assert.equal(rev.run_id, RUN);
    assert.equal(rev.previous_answer, ANSWER);
  });

  it("enforces the per-run auto-apply cap", async () => {
    let hash = (await getItem()).item.baseHash;
    const q = (await current());
    const second = await fix({ baseHash: hash, rationale: "wording 2", question: q.question, answer: `${q.answer} Smoking cessation is advised.` });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    hash = (await getItem()).item.baseHash;
    const q2 = await current();
    const third = await fix({ baseHash: hash, rationale: "wording 3", question: q2.question, answer: `${q2.answer} Counsel patients preoperatively.` });
    assert.equal(third.status, 429);
    assert.equal(third.json.status, "cap_reached");
  });

  it("refuses to revert once the question moved on, then reverts the latest revision", async () => {
    const stale = await call("POST", "/api/internal/question-agent/revert", { revisionId: autoRevisionId });
    assert.equal(stale.status, 409);
    const revs = (await getItem()).revisions.filter((r: any) => r.source === "cloud_agent");
    const latest = revs[0];
    const ok = await call("POST", "/api/internal/question-agent/revert", { revisionId: latest.id, runId: RUN });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await current()).answer, latest.previousAnswer);
  });

  let proposalId = "";
  it("turns an answer-key change into a pending proposal without touching the question", async () => {
    const before = await current();
    const hash = (await getItem()).item.baseHash;
    const r = await fix({
      baseHash: hash,
      rationale: "key should be C",
      question: before.question,
      answer: before.answer.replace(/^A\)/, "C)"),
    });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(r.json.status, "proposed");
    proposalId = r.json.proposalId;
    assert.match(r.json.reasons.join(" "), /key changed/i);
    assert.equal((await current()).answer, before.answer);
    const list = await call("GET", `/api/internal/question-agent/proposals?status=pending&questionId=${encodeURIComponent(QID)}`);
    assert.equal(list.json.proposals.length, 1);
  });

  it("serves a review page only for a valid signed link and applies on approve", async () => {
    const { signReviewLink } = await import("./auth");
    const exp = Date.now() + 60_000;
    const sig = signReviewLink(proposalId, exp)!;
    const bad = await fetch(`${base}/api/question-agent/review/${proposalId}?exp=${exp}&sig=${"0".repeat(64)}`);
    assert.equal(bad.status, 403);
    const agentTokenCannotApprove = await fetch(`${base}/api/question-agent/review/${proposalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${TOKEN}` },
      body: new URLSearchParams({ action: "approve", exp: String(exp), sig: "0".repeat(64) }),
    });
    assert.equal(agentTokenCannotApprove.status, 403);

    const page = await fetch(`${base}/api/question-agent/review/${proposalId}?exp=${exp}&sig=${sig}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, />Approve</);
    assert.match(html, /key changed/i);

    const approve = await fetch(`${base}/api/question-agent/review/${proposalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "approve", exp: String(exp), sig }),
    });
    assert.equal(approve.status, 200);
    assert.match(await approve.text(), /Approved/);
    assert.match((await current()).answer, /^C\)/);
    const rev = (await pool.query(`SELECT source FROM question_revisions WHERE question_id = $1 ORDER BY created_at DESC LIMIT 1`, [QID])).rows[0];
    assert.equal(rev.source, "cloud_agent_approved");

    const again = await fetch(`${base}/api/question-agent/review/${proposalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "approve", exp: String(exp), sig }),
    });
    assert.equal(again.status, 409);
  });

  it("marks a proposal stale when the question changed after it was filed", async () => {
    let q = await current();
    let hash = (await getItem()).item.baseHash;
    const r = await fix({ baseHash: hash, rationale: "key back to A", question: q.question, answer: q.answer.replace(/^C\)/, "A)") });
    assert.equal(r.status, 202);
    await pool.query(`UPDATE questions SET answer = answer || ' (edited by an admin)' WHERE id = $1`, [QID]);
    const { approveProposal } = await import("./store");
    const result = await approveProposal(r.json.proposalId, "test");
    assert.equal(result.ok, false);
    assert.equal((result as any).httpStatus, 409);
    const row = (await pool.query(`SELECT status FROM question_agent_proposals WHERE id = $1`, [r.json.proposalId])).rows[0];
    assert.equal(row.status, "stale");
  });

  it("uploads an image, rejects NC licenses, and attaches only after approval", async () => {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const up = await fetch(`${base}/api/internal/question-agent/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    assert.equal(up.status, 201);
    const uploaded: any = await up.json();
    uploadedFiles.push(uploaded.filename);
    assert.match(uploaded.url, /^\/question-images\/agent\/[0-9a-f-]{36}\.png$/);

    const fake = new FormData();
    fake.append("file", new Blob([Buffer.from("<svg/>")], { type: "image/png" }), "evil.png");
    const bad = await fetch(`${base}/api/internal/question-agent/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fake,
    });
    assert.equal(bad.status, 400);

    const served = await fetch(`${base}${uploaded.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");

    const q = await current();
    const hash = (await getItem()).item.baseHash;
    const nc = await fix({
      baseHash: hash,
      rationale: "add image",
      imageUrl: uploaded.url,
      imageAlt: "Test figure",
      imageAttribution: { credit: "Doe J et al.", license: "CC BY-NC 4.0", pmcid: "PMC1234567" },
    });
    assert.equal(nc.status, 400);
    assert.match(nc.json.message, /license/i);

    const r = await fix({
      baseHash: hash,
      rationale: "add image",
      imageUrl: uploaded.url,
      imageAlt: "Test figure",
      imageAttribution: {
        credit: "Doe J et al.",
        license: "cc by",
        pmcid: "PMC1234567",
        sourceUrl: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/",
      },
    });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal((await current()).image_url, q.image_url, "image must not attach before approval");

    const { approveProposal } = await import("./store");
    const approved = await approveProposal(r.json.proposalId, "test");
    assert.equal(approved.ok, true);
    const row = await current();
    assert.equal(row.image_url, uploaded.url);
    assert.equal(row.image_alt, "Test figure");
    assert.equal(row.image_license, "CC BY");
    assert.equal(row.image_source_pmcid, "PMC1234567");
    assert.equal(row.image_credit, "Doe J et al.");
  });

  it("removes a wrong image and hides the question only after approval", async () => {
    const q = await current();
    assert.ok(q.image_url, "previous test left an image attached");
    await pool.query(`UPDATE questions SET visible = true, flagged = false WHERE id = $1`, [QID]);
    const hash = (await getItem()).item.baseHash;

    // A stem that still promises a photo cannot lose its image while staying live.
    const promised = q.question.replace(/^/, "A clinical photograph is shown. ");
    const blocked = await fix({ baseHash: hash, rationale: "wrong image", question: promised, answer: q.answer, removeImage: true });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.message, /hide/i);

    const conflict = await fix({ baseHash: hash, rationale: "x", removeImage: true, hide: true, unhide: true });
    assert.equal(conflict.status, 400);

    const dry = await fix({ baseHash: hash, rationale: "wrong image", removeImage: true, hide: true }, "?dryRun=true");
    assert.equal(dry.status, 200);
    assert.equal(dry.json.tier, "proposal");

    const r = await fix({ baseHash: hash, rationale: "The image shows a different condition than the stem.", removeImage: true, hide: true });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.ok(r.json.reasons.some((x: string) => x.includes(q.image_url)), "reviewer sees which image is removed");
    const removalPage = await reviewHtml(r.json.proposalId);
    assert.ok(removalPage.includes(`<img src="${q.image_url}"`), "review page shows the image that would be removed");
    assert.match(removalPage, /will remove/i);
    let row = await current();
    assert.equal(row.image_url, q.image_url, "image must stay until approval");
    assert.equal(row.visible, true);

    const { approveProposal } = await import("./store");
    const approved = await approveProposal(r.json.proposalId, "test");
    assert.equal(approved.ok, true);
    row = await current();
    assert.equal(row.image_url, null);
    assert.equal(row.image_credit, null);
    assert.equal(row.image_license, null);
    assert.equal(row.flagged, true);
    assert.equal(row.visible, false);

    const none = await fix({ baseHash: (await getItem()).item.baseHash, rationale: "x", removeImage: true, hide: true });
    assert.equal(none.status, 400, "nothing left to remove");
    assert.match(none.json.message, /no image/i);
  });

  it("refuses to unhide while the stem still promises media", async () => {
    const q = await current();
    const hash = (await getItem()).item.baseHash;
    const promised = q.question.replace(/^/, "A clinical photograph is shown. ");
    const r1 = await fix({ baseHash: hash, rationale: "test", question: promised, answer: q.answer, unhide: true });
    // Image is attached from the previous test, so unhide is allowed; drop the image to test the blocker.
    assert.ok([202, 400].includes(r1.status));
    await pool.query(`UPDATE questions SET image_url = NULL, image_alt = NULL WHERE id = $1`, [QID]);
    await pool.query(`UPDATE questions SET question = $2 WHERE id = $1`, [QID, promised]);
    const hash2 = (await getItem()).item.baseHash;
    const r2 = await fix({ baseHash: hash2, rationale: "unhide", question: promised, answer: q.answer, unhide: true });
    assert.equal(r2.status, 400);
    assert.ok(r2.json.blockers.length > 0);
  });

  it("moves an image from another question only after approval", async () => {
    const sub = await pool.query(`SELECT id FROM subsections ORDER BY id LIMIT 1`);
    await pool.query(
      `INSERT INTO questions (id, subsection_id, question, answer, tags, source, visible, image_url, image_alt, image_credit, image_license)
       VALUES ($1,$2,$3,$4,'[]'::jsonb,'imported',true,'/question-images/zz-move-test.jpg','A floating thumb','Doe J et al.','CC BY')`,
      [SRC, sub.rows[0].id, "A clinical photograph is shown. " + QUESTION, ANSWER]
    );
    const hash = (await getItem()).item.baseHash;
    const moveBody = { baseHash: hash, rationale: "This image belongs on this question.", moveImageFromQuestionId: SRC };

    assert.equal((await fix({ ...moveBody, moveImageFromQuestionId: QID })).status, 400, "same question");
    assert.equal((await fix({ ...moveBody, moveImageFromQuestionId: "zz-does-not-exist" })).status, 404);
    assert.equal((await fix({ ...moveBody, removeImage: true })).status, 400, "cannot combine with removeImage");

    const dry = await fix(moveBody, "?dryRun=true");
    assert.equal(dry.status, 200);
    assert.equal(dry.json.tier, "proposal");

    const r = await fix(moveBody);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.ok(r.json.reasons.some((x: string) => x.includes(SRC)), "reviewer sees where the image comes from");
    const movePage = await reviewHtml(r.json.proposalId);
    assert.ok(movePage.includes('<img src="/question-images/zz-move-test.jpg"'), "review page shows the proposed image");
    assert.ok(movePage.includes(SRC), "review page shows the source question");
    assert.match(movePage, /Proposed image/i);
    let target = await current();
    let source = (await pool.query(`SELECT * FROM questions WHERE id = $1`, [SRC])).rows[0];
    assert.equal(target.image_url, null, "nothing moves before approval");
    assert.equal(source.image_url, "/question-images/zz-move-test.jpg");

    const { approveProposal } = await import("./store");
    const approved = await approveProposal(r.json.proposalId, "test");
    assert.equal(approved.ok, true);
    target = await current();
    source = (await pool.query(`SELECT * FROM questions WHERE id = $1`, [SRC])).rows[0];
    assert.equal(target.image_url, "/question-images/zz-move-test.jpg");
    assert.equal(target.image_alt, "A floating thumb");
    assert.equal(target.image_credit, "Doe J et al.");
    assert.equal(target.image_license, "CC BY");
    assert.equal(source.image_url, null);
    assert.equal(source.image_credit, null);
    assert.equal(source.flagged, true, "source stem promises a photo, so it is hidden");
    assert.equal(source.visible, false);

    const again = await fix({ ...moveBody, baseHash: (await getItem()).item.baseHash });
    assert.equal(again.status, 400, "source has nothing left to move");
  });

  it("a move supersedes a pending image-removal on the source, but not other proposals; goes stale if the source image changes", async () => {
    await pool.query(`UPDATE questions SET image_url = '/question-images/zz-move-test.jpg', image_alt = 'x', flagged = false, visible = true WHERE id = $1`, [SRC]);
    await pool.query(`UPDATE questions SET image_url = NULL, image_alt = NULL WHERE id = $1`, [QID]);
    const srcItem = (await call("GET", `/api/internal/question-agent/question/${encodeURIComponent(SRC)}`)).json.item;
    const srcFix = (body: Record<string, unknown>) =>
      call("POST", "/api/internal/question-agent/fix", { questionId: SRC, runId: RUN, baseHash: srcItem.baseHash, ...body });

    // A non-removal proposal on the source blocks the move.
    const textChange = await srcFix({ rationale: "wording", question: srcItem.question + " Choose one.", answer: srcItem.answer });
    assert.equal(textChange.status, 202, JSON.stringify(textChange.json));
    const blocked = await fix({ baseHash: (await getItem()).item.baseHash, rationale: "move", moveImageFromQuestionId: SRC });
    assert.equal(blocked.status, 409);
    const { rejectProposal, approveProposal } = await import("./store");
    await rejectProposal(textChange.json.proposalId, "test");

    // A plain removal proposal on the source is superseded by the move.
    const held = await srcFix({ rationale: "wrong image", removeImage: true, hide: true });
    assert.equal(held.status, 202, JSON.stringify(held.json));
    const dry = await fix({ baseHash: (await getItem()).item.baseHash, rationale: "move", moveImageFromQuestionId: SRC }, "?dryRun=true");
    assert.equal(dry.status, 200);
    const stillPending = await pool.query(`SELECT status FROM question_agent_proposals WHERE id = $1`, [held.json.proposalId]);
    assert.equal(stillPending.rows[0].status, "pending", "a dry run must not supersede anything");

    const move = await fix({ baseHash: (await getItem()).item.baseHash, rationale: "move", moveImageFromQuestionId: SRC });
    assert.equal(move.status, 202, JSON.stringify(move.json));
    const superseded = await pool.query(`SELECT status FROM question_agent_proposals WHERE id = $1`, [held.json.proposalId]);
    assert.equal(superseded.rows[0].status, "superseded");

    // Change the source image before approval: the move goes stale and attaches nothing.
    await pool.query(`UPDATE questions SET image_url = '/question-images/zz-other.jpg' WHERE id = $1`, [SRC]);
    const res = await approveProposal(move.json.proposalId, "test");
    assert.equal(res.ok, false);
    assert.equal((res as any).httpStatus, 409);
    assert.equal((await current()).image_url, null, "stale move must not attach anything");
  });

  it("exports a read-only content snapshot", async () => {
    const r = await call("GET", "/api/internal/question-agent/export?specialty=prs");
    assert.equal(r.status, 200);
    assert.equal(r.json.file.specialtyId, "prs");
    assert.ok(r.json.file.questions.length > 100);
    assert.ok(r.json.file.questions.every((x: any) => "imageCredit" in x));
  });
});
