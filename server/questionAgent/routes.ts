/**
 * HTTP API for the question-fix cloud agent.
 *
 * Agent-facing (Bearer QUESTION_AGENT_TOKEN, 404 on bad auth like /api/internal/*):
 *   GET  /api/internal/question-agent/queue
 *   GET  /api/internal/question-agent/question/:id
 *   POST /api/internal/question-agent/fix          (?dryRun=true supported)
 *   POST /api/internal/question-agent/image        (multipart "file")
 *   POST /api/internal/question-agent/revert
 *   GET  /api/internal/question-agent/proposals
 *   GET  /api/internal/question-agent/export       (read-only content snapshot for prod-to-repo pull)
 *
 * Human-facing (HMAC-signed link posted to Slack; QUESTION_AGENT_APPROVAL_SECRET, not known to the agent):
 *   GET  /api/question-agent/review/:id
 *   POST /api/question-agent/review/:id
 *
 * Public image serving for agent-sourced images:
 *   GET  /question-images/agent/:file
 */
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { pool } from "../db";
import { isSpecialtyId } from "@shared/specialties";
import { assessImageLicense } from "@shared/imageLicense";
import { buildSpecialtyContentFile } from "../content/specialtyContent";
import {
  approvalSecret,
  questionAgentTokenConfigured,
  requireQuestionAgentToken,
  verifyReviewSignature,
} from "./auth";
import {
  AGENT_IMAGE_FILE_RE,
  AGENT_IMAGE_URL_PREFIX,
  allowedImageMime,
  loadAgentImage,
  sniffImageMime,
  storeAgentImage,
} from "./imageBucket";
import {
  ALL_QUEUE_CATEGORIES,
  AGENT_REVISION_SOURCE,
  LIMITS,
  agentCaps,
  applyTextChange,
  approveProposal,
  classify,
  countAutoApplied,
  countProposalsForRun,
  createProposal,
  getProposal,
  getQueueItem,
  hashQuestion,
  listProposals,
  listQueue,
  listRevisions,
  rejectProposal,
  revertRevision,
  unhideBlockers,
  validateTextFields,
  type QueueCategory,
} from "./store";
import { renderMessagePage, renderReviewPage } from "./reviewPage";
import { notifyAutoAppliedSlack, notifyProposalSlack } from "./slack";
import { createHash } from "crypto";

const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests." },
});
const authFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  // Only failed authentication counts against this limiter, not ordinary 4xx responses.
  requestWasSuccessful: (_req, res) => !res.locals.authFailed,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests." },
});
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests.",
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function agentAuth(req: Request, res: Response, next: NextFunction) {
  if (!requireQuestionAgentToken(req)) {
    res.locals.authFailed = true;
    return res.status(404).json({ message: "Not found." });
  }
  next();
}

function paramOf(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

interface AttributionInput {
  pmcid: string | null;
  credit: string;
  license: string;
  sourceUrl: string | null;
}

function parseAttribution(raw: unknown): { ok: true; value: AttributionInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "imageAttribution is required with an image." };
  const r = raw as Record<string, unknown>;
  const credit = str(r.credit)?.trim() ?? "";
  if (!credit) return { ok: false, error: "imageAttribution.credit is required." };
  if (credit.length > LIMITS.credit) return { ok: false, error: "imageAttribution.credit is too long." };
  const verdict = assessImageLicense(str(r.license));
  if (!verdict.allowed || !verdict.canonical) {
    return { ok: false, error: `Image license not allowed: ${verdict.reason ?? "unknown"}. Allowed: CC0, CC BY, CC BY-SA, public domain.` };
  }
  const sourceUrl = str(r.sourceUrl)?.trim() || null;
  if (sourceUrl && !/^https:\/\/[^\s]+$/i.test(sourceUrl)) {
    return { ok: false, error: "imageAttribution.sourceUrl must be an https URL." };
  }
  if (sourceUrl && sourceUrl.length > 512) return { ok: false, error: "imageAttribution.sourceUrl is too long." };
  const pmcid = str(r.pmcid)?.trim() || null;
  if (pmcid && !/^PMC\d{4,10}$/i.test(pmcid)) return { ok: false, error: "imageAttribution.pmcid must look like PMC1234567." };
  return { ok: true, value: { pmcid: pmcid ? pmcid.toUpperCase() : null, credit, license: verdict.canonical, sourceUrl } };
}

export function registerQuestionAgentRoutes(app: Express): void {
  if (!questionAgentTokenConfigured()) {
    console.warn("[questionAgent] QUESTION_AGENT_TOKEN not set (min 24 chars); agent endpoints return 404.");
  }
  if (!approvalSecret()) {
    console.warn("[questionAgent] QUESTION_AGENT_APPROVAL_SECRET not set; Slack proposals will have no review link.");
  }

  // ---- Public serving of agent-sourced images ------------------------------------------------
  app.get("/question-images/agent/:file", async (req, res) => {
    const file = paramOf(req.params.file);
    if (!AGENT_IMAGE_FILE_RE.test(file)) return res.status(404).end();
    try {
      const img = await loadAgentImage(file);
      if (!img) return res.status(404).end();
      res.setHeader("Content-Type", img.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.send(img.body);
    } catch (err) {
      console.error("[questionAgent] image serve failed:", err);
      res.status(502).end();
    }
  });

  const base = "/api/internal/question-agent";
  app.use(base, authFailureLimiter, agentAuth, agentLimiter);

  // ---- Queue ---------------------------------------------------------------------------------
  app.get(`${base}/queue`, async (req, res) => {
    try {
      const catParam = str(req.query.category);
      const categories = catParam
        ? (catParam.split(",").map((c) => c.trim()).filter((c): c is QueueCategory =>
            (ALL_QUEUE_CATEGORIES as string[]).includes(c)
          ))
        : ALL_QUEUE_CATEGORIES;
      if (categories.length === 0) {
        return res.status(400).json({ message: `category must be one of: ${ALL_QUEUE_CATEGORIES.join(", ")}` });
      }
      const specialty = str(req.query.specialty);
      if (specialty && !isSpecialtyId(specialty)) {
        return res.status(400).json({ message: "specialty must be prs or ortho." });
      }
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const result = await listQueue({
        categories,
        specialtyId: specialty && isSpecialtyId(specialty) ? specialty : undefined,
        limit,
        offset,
        includePending: truthy(req.query.includePending),
      });
      res.json({ ...result, limit, offset, caps: agentCaps() });
    } catch (err) {
      console.error("[questionAgent] queue failed:", err);
      res.status(500).json({ message: "Failed to load queue." });
    }
  });

  app.get(`${base}/question/:id`, async (req, res) => {
    try {
      const item = await getQueueItem(paramOf(req.params.id));
      if (!item) return res.status(404).json({ message: "Question not found." });
      const revisions = await listRevisions(item.id, 10);
      const proposals = await listProposals({ questionId: item.id, limit: 10 });
      res.json({ item, revisions, proposals });
    } catch (err) {
      console.error("[questionAgent] question failed:", err);
      res.status(500).json({ message: "Failed to load question." });
    }
  });

  // ---- Fix / proposal ------------------------------------------------------------------------
  app.post(`${base}/fix`, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = truthy(req.query.dryRun) || truthy(body.dryRun);

      const questionId = str(body.questionId)?.trim();
      const runId = str(body.runId)?.trim();
      const rationale = str(body.rationale)?.trim();
      const baseHash = str(body.baseHash)?.trim();
      if (!questionId) return res.status(400).json({ message: "questionId is required." });
      if (!runId || !RUN_ID_RE.test(runId)) {
        return res.status(400).json({ message: "runId is required (8-64 chars: letters, digits, . _ : -)." });
      }
      if (!rationale) return res.status(400).json({ message: "rationale is required for the audit trail." });
      if (rationale.length > LIMITS.rationale) {
        return res.status(400).json({ message: `rationale exceeds ${LIMITS.rationale} characters.` });
      }
      if (!baseHash) return res.status(400).json({ message: "baseHash is required (from the queue item)." });

      const existing = await storage.getQuestion(questionId);
      if (!existing) return res.status(404).json({ message: "Question not found." });
      const currentHash = hashQuestion(existing.question, existing.answer);
      if (baseHash !== currentHash) {
        return res.status(409).json({
          status: "stale",
          message: "The question changed since you read it. Re-fetch it and redo the fix.",
          currentHash,
        });
      }

      // Text
      const hasText = body.question !== undefined || body.answer !== undefined;
      let nextQuestion = existing.question;
      let nextAnswer = existing.answer;
      if (hasText) {
        const q = str(body.question);
        const a = str(body.answer);
        if (q === undefined || a === undefined) {
          return res.status(400).json({ message: "question and answer must both be strings." });
        }
        nextQuestion = q.trim();
        nextAnswer = a.trim();
        const errors = validateTextFields(nextQuestion, nextAnswer, rationale);
        if (errors.length > 0) {
          return res.status(400).json({ status: "invalid", message: "Text failed validation.", errors });
        }
      }

      // Image
      let imageUrl: string | null = null;
      let imageAlt: string | null = null;
      let attribution: AttributionInput | null = null;
      if (body.imageUrl !== undefined && body.imageUrl !== null) {
        imageUrl = str(body.imageUrl)?.trim() ?? "";
        const file = imageUrl.startsWith(AGENT_IMAGE_URL_PREFIX) ? imageUrl.slice(AGENT_IMAGE_URL_PREFIX.length) : "";
        if (!AGENT_IMAGE_FILE_RE.test(file)) {
          return res.status(400).json({
            message: `imageUrl must be a URL returned by the image upload endpoint (${AGENT_IMAGE_URL_PREFIX}<uuid>.<ext>).`,
          });
        }
        imageAlt = str(body.imageAlt)?.trim() ?? "";
        if (!imageAlt) return res.status(400).json({ message: "imageAlt is required with an image." });
        if (imageAlt.length > LIMITS.imageAlt) {
          return res.status(400).json({ message: `imageAlt exceeds ${LIMITS.imageAlt} characters.` });
        }
        const parsed = parseAttribution(body.imageAttribution);
        if (!parsed.ok) return res.status(400).json({ message: parsed.error });
        attribution = parsed.value;
        const stored = await loadAgentImage(file);
        if (!stored) return res.status(400).json({ message: "That image was not found in storage. Upload it first." });
      }
      const wantsUnhide = truthy(body.unhide);

      if (wantsUnhide) {
        const blockers = unhideBlockers(nextQuestion, !!imageUrl || !!existing.imageUrl);
        if (blockers.length > 0) {
          return res.status(400).json({ status: "invalid", message: "Cannot unhide with this text and image.", blockers });
        }
      }

      const cls = classify(
        { question: existing.question, answer: existing.answer },
        { question: nextQuestion, answer: nextAnswer },
        { hasImageChange: !!imageUrl, wantsUnhide }
      );
      const noOp = cls.unchanged && !imageUrl && !wantsUnhide;
      if (noOp) return res.json({ status: "unchanged", questionId, baseHash: currentHash });

      const caps = agentCaps();
      const textChanged = !cls.unchanged;

      if (cls.tier === "auto") {
        const [runCount, dayCount] = await Promise.all([
          countAutoApplied({ runId }),
          countAutoApplied({ sinceMs: 24 * 60 * 60 * 1000 }),
        ]);
        const capHit =
          runCount >= caps.autoPerRun
            ? `per-run auto-apply cap reached (${caps.autoPerRun})`
            : dayCount >= caps.autoPerDay
              ? `daily auto-apply cap reached (${caps.autoPerDay})`
              : null;
        if (dryRun) {
          return res.json({
            status: "dry_run",
            tier: "auto",
            autoChanges: cls.autoChanges,
            wouldApply: !capHit,
            capBlocked: capHit,
            baseHash: currentHash,
          });
        }
        if (capHit) return res.status(429).json({ status: "cap_reached", message: capHit });
        if (!textChanged) return res.json({ status: "unchanged", questionId, baseHash: currentHash });

        const revision = await applyTextChange({
          questionId,
          previousQuestion: existing.question,
          previousAnswer: existing.answer,
          newQuestion: nextQuestion,
          newAnswer: nextAnswer,
          source: AGENT_REVISION_SOURCE,
          rationale,
          runId,
        });
        const specialty = (await getQueueItem(questionId))?.specialtyId;
        void notifyAutoAppliedSlack({
          questionId,
          specialtyId: specialty,
          changes: cls.autoChanges,
          rationale,
          revisionId: revision.id,
          runId,
        });
        return res.json({
          status: "applied",
          tier: "auto",
          autoChanges: cls.autoChanges,
          revisionId: revision.id,
          baseHash: hashQuestion(nextQuestion, nextAnswer),
        });
      }

      // proposal tier
      const proposalsSoFar = await countProposalsForRun(runId);
      if (dryRun) {
        return res.json({
          status: "dry_run",
          tier: "proposal",
          reasons: cls.reasons,
          wouldPropose: proposalsSoFar < caps.proposalsPerRun,
          baseHash: currentHash,
        });
      }
      if (proposalsSoFar >= caps.proposalsPerRun) {
        return res.status(429).json({
          status: "cap_reached",
          message: `per-run proposal cap reached (${caps.proposalsPerRun})`,
        });
      }
      const proposal = await createProposal({
        questionId,
        baseHash: currentHash,
        previousQuestion: existing.question,
        previousAnswer: existing.answer,
        newQuestion: textChanged ? nextQuestion : null,
        newAnswer: textChanged ? nextAnswer : null,
        imageUrl,
        imageAlt,
        imageAttribution: attribution,
        unhide: wantsUnhide,
        rationale,
        reasons: cls.reasons,
        runId,
      });
      const specialty = (await getQueueItem(questionId))?.specialtyId;
      const slackNotified = await notifyProposalSlack(proposal, specialty);
      return res.status(202).json({
        status: "proposed",
        tier: "proposal",
        proposalId: proposal.id,
        reasons: cls.reasons,
        slackNotified,
        reviewLinkConfigured: !!approvalSecret(),
      });
    } catch (err) {
      console.error("[questionAgent] fix failed:", err);
      res.status(500).json({ message: "Failed to process fix." });
    }
  });

  // ---- Image upload --------------------------------------------------------------------------
  app.post(`${base}/image`, (req, res) => {
    imageUpload.single("file")(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        const message = uploadErr instanceof Error ? uploadErr.message : "Upload failed.";
        return res.status(400).json({ message });
      }
      try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ message: 'Missing multipart field "file".' });
        const sniffed = sniffImageMime(file.buffer);
        if (!sniffed || !allowedImageMime(sniffed)) {
          return res.status(400).json({ message: "File is not a JPEG, PNG, WebP, or GIF image." });
        }
        const stored = await storeAgentImage(file.buffer, sniffed);
        res.status(201).json({
          url: stored.url,
          filename: stored.filename,
          bytes: file.buffer.length,
          sha256: createHash("sha256").update(file.buffer).digest("hex"),
        });
      } catch (err) {
        console.error("[questionAgent] image upload failed:", err);
        res.status(500).json({ message: err instanceof Error ? err.message : "Upload failed." });
      }
    });
  });

  // ---- Revert --------------------------------------------------------------------------------
  app.post(`${base}/revert`, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const revisionId = str(body.revisionId)?.trim();
      const runId = str(body.runId)?.trim();
      if (!revisionId) return res.status(400).json({ message: "revisionId is required." });
      if (runId && !RUN_ID_RE.test(runId)) return res.status(400).json({ message: "Invalid runId." });
      const result = await revertRevision({
        revisionId,
        runId: runId ?? null,
        rationale: str(body.rationale) ?? null,
      });
      if (!result.ok) return res.status(result.status).json({ message: result.message });
      res.json({ status: "reverted", questionId: result.questionId });
    } catch (err) {
      console.error("[questionAgent] revert failed:", err);
      res.status(500).json({ message: "Failed to revert." });
    }
  });

  // ---- Proposals (status polling) -------------------------------------------------------------
  app.get(`${base}/proposals`, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const rows = await listProposals({
        status: str(req.query.status),
        runId: str(req.query.runId),
        questionId: str(req.query.questionId),
        limit,
      });
      res.json({ proposals: rows });
    } catch (err) {
      console.error("[questionAgent] proposals failed:", err);
      res.status(500).json({ message: "Failed to list proposals." });
    }
  });

  // ---- Read-only export (prod -> repo pull) ---------------------------------------------------
  app.get(`${base}/export`, async (req, res) => {
    try {
      const specialty = str(req.query.specialty);
      if (!specialty || !isSpecialtyId(specialty)) {
        return res.status(400).json({ message: "specialty must be prs or ortho." });
      }
      const { file, orphanQuestionsSkipped } = await buildSpecialtyContentFile(pool, specialty, "production");
      res.json({ file, orphanQuestionsSkipped });
    } catch (err) {
      console.error("[questionAgent] export failed:", err);
      res.status(500).json({ message: "Failed to export content." });
    }
  });

  // ---- Human review (signed link from Slack) --------------------------------------------------
  const reviewHeaders = (res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.type("html");
  };

  app.get("/api/question-agent/review/:id", reviewLimiter, async (req, res) => {
    reviewHeaders(res);
    const exp = Number(req.query.exp);
    const sig = str(req.query.sig) ?? "";
    if (!verifyReviewSignature(paramOf(req.params.id), exp, sig)) {
      return res.status(403).send(renderMessagePage("Link invalid or expired", "Ask for a fresh review link."));
    }
    const proposal = await getProposal(paramOf(req.params.id));
    if (!proposal) return res.status(404).send(renderMessagePage("Not found", "This proposal does not exist."));
    const current = await storage.getQuestion(proposal.questionId);
    const stale = !!current && hashQuestion(current.question, current.answer) !== proposal.baseHash;
    res.send(
      renderReviewPage({
        proposal,
        exp,
        sig,
        postPath: `/api/question-agent/review/${encodeURIComponent(proposal.id)}`,
        stale,
      })
    );
  });

  app.post("/api/question-agent/review/:id", reviewLimiter, async (req, res) => {
    reviewHeaders(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const exp = Number(body.exp);
    const sig = str(body.sig) ?? "";
    if (!verifyReviewSignature(paramOf(req.params.id), exp, sig)) {
      return res.status(403).send(renderMessagePage("Link invalid or expired", "Ask for a fresh review link."));
    }
    const action = str(body.action);
    if (action !== "approve" && action !== "reject") {
      return res.status(400).send(renderMessagePage("Bad request", "Unknown action."));
    }
    try {
      const result =
        action === "approve"
          ? await approveProposal(paramOf(req.params.id), "slack-review-link")
          : await rejectProposal(paramOf(req.params.id), "slack-review-link");
      if (!result.ok) {
        return res.status(result.httpStatus).send(renderMessagePage("Not applied", result.message));
      }
      if (result.status === "approved") {
        const extra =
          result.unhide && !result.unhide.ok
            ? ` The change was applied, but the question stays hidden: ${result.unhide.blockers.join("; ")}.`
            : "";
        return res.send(renderMessagePage("Approved", `The proposal was applied to the live question.${extra}`));
      }
      return res.send(renderMessagePage("Rejected", "The proposal was rejected. Nothing changed."));
    } catch (err) {
      console.error("[questionAgent] review decision failed:", err);
      return res.status(500).send(renderMessagePage("Error", "Something went wrong. Check the server logs."));
    }
  });
}
