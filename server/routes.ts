import type { Express } from "express";
import { createServer, type Server } from "http";
import { timingSafeEqual } from "crypto";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, supportFormRateLimiter } from "./customAuth";
import { sanitizeUser } from "./authUtils";
import { createTesterRedirectToken, verifyTesterRedirectToken, ATLAS_TRAINER_CALLBACK_URL } from "./testerToken";
import { insertTestSessionSchema, updateTestSessionSchema, insertQuestionResponseSchema, insertQuestionSchema } from "@shared/schemas";
import {
  validateQuestionFormat,
  contentRulesForGenerated,
  extractQuestionStem,
  questionMcqChoicesReferenceSeeImage,
} from "@shared/questionFormat";
import { subsectionOrder, subsectionTitles } from "@shared/questionImport";
import type { User, SubscriptionTransaction } from "@shared/schema";
import {
  DEFAULT_SPECIALTY_ID,
  SPECIALTY_LIST,
  getSpecialty,
  isKnownSpecialtyHost,
  isOrthoContentId,
  isSpecialtyId,
  type SpecialtyId,
} from "@shared/specialties";
import { userHasAdminForeverAccess } from "./adminGrantedAccess";
import {
  accessDurationDaysForCodeType,
  institutionalAccessExpiresAtForRedemption,
  institutionalDaysRemaining,
  normalizeInstitutionalCodeForLookup,
  parseInstitutionalCodeType,
} from "./institutionalAccess";
import { getSpecialtyForHost, requestHostname } from "./seoPublic";
import {
  databaseLabelForSpecialty,
  notifyPlanPurchaseSlack,
  notifyQuestionReportSlack,
  notifySupportFormSlack,
  scheduleSlackNotify,
  sendSupportContactEmail,
  slackFieldsFromQuestion,
} from "./notifySupport";

const ADMIN_CODE = process.env.ADMIN_CODE || "1127";

/** Paid personal plans (Stripe / checkout); institutional is excluded. */
const PAID_SUBSCRIPTION_PLAN_NAMES = new Set([
  "monthly",
  "6-month",
  "1-year",
  "1-month",
  "3-month",
]);

/**
 * True when the user should be treated as on a personal paid/trial subscription path.
 * Takes precedence over institutional access for API + UI so a paid sub overrides an old institutional grant.
 */
function userHasPersonalSubscriptionAccess(
  user: User | undefined,
  activeTx?: SubscriptionTransaction | undefined
): boolean {
  if (!user) return false;
  if (userHasAdminForeverAccess(user)) return true;
  const now = Date.now();

  const plan = user.subscriptionPlan ?? undefined;
  const hasNamedPaidPlan = plan ? PAID_SUBSCRIPTION_PLAN_NAMES.has(plan) : false;
  const txEndOk = !!(activeTx && new Date(activeTx.endDate).getTime() > now);

  const st = user.subscriptionStatus || "trial";

  /**
   * Stale `stripe_subscription_id` (e.g. after cancel or webhook lag) must NOT block institutional access.
   * Only treat Stripe as "personal access" when status + dates show real ongoing entitlement.
   */
  if (user.stripeSubscriptionId?.trim()) {
    if (st === "active") return true;
    if (st === "trial" && user.trialEndsAt && new Date(user.trialEndsAt).getTime() > now) return true;
    if (st === "canceled" && user.subscriptionEndsAt && new Date(user.subscriptionEndsAt).getTime() > now)
      return true;
    if (txEndOk) return true;
    // else: expired / ended sub with leftover id — fall through to plan/tx checks only
  }

  if (!hasNamedPaidPlan) {
    return txEndOk;
  }

  if (st === "active") return true;
  if (st === "trial" && user.trialEndsAt && new Date(user.trialEndsAt).getTime() > now) return true;
  if (st === "canceled" && user.subscriptionEndsAt && new Date(user.subscriptionEndsAt).getTime() > now)
    return true;
  return txEndOk;
}

/** True when the user row reflects an ongoing personal (paid/trial) period — institutional UI should not replace this. */
function userHasCoherentPersonalPaidRow(user: User | undefined, now: Date): boolean {
  if (!user) return false;
  if (userHasAdminForeverAccess(user)) return true;
  const st = user.subscriptionStatus || "trial";
  const userEndsAt = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
  if (st === "active" && userEndsAt && userEndsAt.getTime() > now.getTime()) return true;
  if (st === "canceled" && userEndsAt && userEndsAt.getTime() > now.getTime()) return true;
  if (st === "trial" && trialEndsAt && trialEndsAt.getTime() > now.getTime()) return true;
  return false;
}

/**
 * Institutional access is granted only by redeeming a code (`user_institutional_code_redemptions`),
 * not by profile `institutional_affiliation`. Requires a future `institutional_access_expires_at`.
 */
function institutionalAccessPeriodActive(
  hasCodeRedemption: boolean,
  user: User | undefined,
  now: Date
): boolean {
  if (!hasCodeRedemption || !user) return false;
  const exp = user.institutionalAccessExpiresAt ? new Date(user.institutionalAccessExpiresAt) : null;
  if (!exp || exp.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Same rule as GET /api/subscription/details institutional branch: code redemption is required,
 * and stale personal/Stripe rows must not send "Remove access" through the paid cancel path.
 */
async function userIsInstitutionalPrimaryAccess(
  userId: string,
  user: User | undefined,
  now: Date,
  specialtyId: SpecialtyId
): Promise<boolean> {
  if (!user) return false;
  const hasRedemption = await storage.userHasAnyInstitutionalRedemption(userId, specialtyId);
  if (!institutionalAccessPeriodActive(hasRedemption, user, now)) return false;
  return !userHasCoherentPersonalPaidRow(user, now);
}

/**
 * Origin the browser is actually on, so Stripe returns the user to the domain they started from
 * (prs-atlas.com vs ortho-atlas.com) instead of a single hardcoded origin.
 */
function requestOrigin(req: any): string | null {
  const host = req.get?.("host");
  if (!host) return null;
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "https";
  return `${proto}://${host}`;
}

/**
 * The q-bank a request applies to: an explicit `specialtyId` in the body/query when present,
 * otherwise the user's active specialty, otherwise the request host's specialty.
 */
async function resolveRequestSpecialty(req: any): Promise<SpecialtyId> {
  const requested = req.body?.specialtyId ?? req.query?.specialtyId;
  if (isSpecialtyId(requested)) return requested;
  const hostname = requestHostname(req);
  // Production specialty hosts always serve that domain's bank so a leftover
  // activeSpecialty from the other product cannot empty the dashboard.
  if (isKnownSpecialtyHost(hostname)) {
    return getSpecialtyForHost(hostname);
  }
  const userId = req.session?.userId;
  if (userId) {
    const active = await storage.getActiveSpecialty(userId);
    if (active) return active;
  }
  return getSpecialtyForHost(hostname);
}

/**
 * Loads the user with its entitlement columns scoped to one q-bank, so the entitlement rules below
 * (written against the legacy single-specialty user shape) stay correct per specialty.
 */
async function loadUserForSubscription(
  userId: string,
  specialtyId: SpecialtyId
): Promise<{
  user: User | undefined;
  hasInstitutionalRedemption: boolean;
}> {
  const user = await storage.getUserWithSpecialtyEntitlement(userId, specialtyId);
  if (!user) return { user: undefined, hasInstitutionalRedemption: false };
  const hasInstitutionalRedemption = await storage.userHasAnyInstitutionalRedemption(
    userId,
    specialtyId
  );
  return { user, hasInstitutionalRedemption };
}

type SubscriptionState = {
  status: string;
  daysRemaining: number | null;
  trialEndsAt: Date | null;
  isLocked: boolean;
  specialtyId: SpecialtyId;
  subscriptionType?: string;
  grantKind?: "trial" | "institutional";
};

/**
 * Access state for one (user, q-bank) pair. Also self-heals stale rows the same way the old
 * single-specialty endpoint did (expired trials, cancel-at-period-end past its end date).
 */
async function computeSubscriptionState(
  userId: string,
  specialtyId: SpecialtyId
): Promise<SubscriptionState> {
  const { user, hasInstitutionalRedemption } = await loadUserForSubscription(userId, specialtyId);
  if (!user) {
    return { status: 'none', daysRemaining: 0, trialEndsAt: null, isLocked: false, specialtyId };
  }

  if (userHasAdminForeverAccess(user)) {
    return { status: 'active', daysRemaining: null, trialEndsAt: null, isLocked: false, specialtyId };
  }

  const institutionalExpiresAt = user.institutionalAccessExpiresAt
    ? new Date(user.institutionalAccessExpiresAt)
    : null;
  const institutionalExpired =
    institutionalExpiresAt !== null && institutionalExpiresAt.getTime() <= Date.now();
  /** Clear display name after natural expiry; keep expires_at so we never re-backfill access from redemption row alone. */
  if (institutionalExpired && hasInstitutionalRedemption && user.institutionalAccessAffiliation?.trim()) {
    await storage.updateSpecialtyEntitlement(userId, specialtyId, {
      institutionalAccessAffiliation: null,
    });
  }
  const hasInstitutionalAccess = institutionalAccessPeriodActive(
    hasInstitutionalRedemption,
    user,
    new Date()
  );

  const now = new Date();
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
  const subscriptionEndsAt = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
  const activeSubscription = await storage.getUserActiveSubscription(userId, specialtyId);
  const activeEndDate = activeSubscription?.endDate ? new Date(activeSubscription.endDate) : null;
  const cancelAtPeriodEnd = user.subscriptionCancelAtPeriodEnd === true;

  let status = user.subscriptionStatus || 'trial';
  let daysRemaining = 0;

  const futureCandidates: Date[] = [];
  if (subscriptionEndsAt && subscriptionEndsAt.getTime() > now.getTime()) futureCandidates.push(subscriptionEndsAt);
  if (activeEndDate && activeEndDate.getTime() > now.getTime()) futureCandidates.push(activeEndDate);
  const bestFutureEnd =
    futureCandidates.length > 0
      ? futureCandidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
      : null;

  // Dedicated cancellation flag controls "canceled but active until end date" semantics.
  if (cancelAtPeriodEnd && bestFutureEnd) {
    status = 'canceled';
  } else if (cancelAtPeriodEnd && !bestFutureEnd) {
    status = 'expired';
    await storage.updateSpecialtyEntitlement(userId, specialtyId, {
      subscriptionStatus: 'expired',
      subscriptionCancelAtPeriodEnd: false,
    });
  }

  if (status === 'canceled' && bestFutureEnd) {
    daysRemaining = Math.max(0, Math.ceil((bestFutureEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  } else if ((status === 'active' || status === 'trial') && bestFutureEnd) {
    daysRemaining = Math.max(0, Math.ceil((bestFutureEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  } else if (trialEndsAt) {
    const diffTime = trialEndsAt.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    if (daysRemaining === 0 && status === 'trial') {
      status = 'expired';
      await storage.updateSpecialtyEntitlement(userId, specialtyId, {
        subscriptionStatus: 'expired',
      });
    }
  }

  // Lock when expired or when on trial with no days left (e.g. new account with no plan). Canceled = access until end.
  // Expiry/cancel only update subscription status; user data (progress, notes, bookmarks) is never deleted.
  const isLocked =
    status === 'expired' ||
    (status === 'trial' && daysRemaining === 0) ||
    (status === 'canceled' && (!bestFutureEnd || bestFutureEnd <= now));

  /**
   * Valid institutional access must unlock the app even when personal row still says "expired"
   * (e.g. leftover Stripe ids, edge cases in personal-access detection).
   */
  if (hasInstitutionalAccess && isLocked) {
    const grant = await storage.getLatestInstitutionalCodeGrant(userId, specialtyId);
    const isTrialGrant = grant?.codeType === "trial";
    return {
      status: "institutional",
      daysRemaining: institutionalExpiresAt
        ? institutionalDaysRemaining(institutionalExpiresAt)
        : null,
      trialEndsAt: isTrialGrant ? institutionalExpiresAt : null,
      isLocked: false,
      specialtyId,
      subscriptionType: isTrialGrant ? "30-Day Trial" : "Institutional Access",
      grantKind: isTrialGrant ? "trial" : "institutional",
    };
  }

  return { status, daysRemaining, trialEndsAt, isLocked, specialtyId };
}

async function specialtyIsLocked(userId: string, specialtyId: SpecialtyId): Promise<boolean> {
  const state = await computeSubscriptionState(userId, specialtyId);
  return state.isLocked;
}

const QUESTION_IMPORT_API_KEY = process.env.QUESTION_IMPORT_API_KEY;

function requireAdminCode(req: any): boolean {
  const code = req.headers["x-admin-code"];
  return code === ADMIN_CODE;
}

/** Require QUESTION_IMPORT_API_KEY via Authorization: Bearer <key> or X-API-Key header. */
function requireImportApiKey(req: any): boolean {
  if (!QUESTION_IMPORT_API_KEY) return false;
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const headerKey = req.headers["x-api-key"];
  return bearer === QUESTION_IMPORT_API_KEY || headerKey === QUESTION_IMPORT_API_KEY;
}

function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireFeedbackAgentSecret(req: any): boolean {
  const expected = process.env.FEEDBACK_AGENT_SECRET?.trim();
  if (!expected) return false;
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  const header = typeof req.headers["x-feedback-agent-secret"] === "string"
    ? req.headers["x-feedback-agent-secret"]
    : "";
  return secretsEqual(bearer, expected) || secretsEqual(header, expected);
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Set up authentication middleware
  await setupAuth(app);

  try {
    await storage.warmupSubscriptionSchema();
  } catch (err) {
    console.error("Subscription schema warmup failed; server continuing:", err);
  }

  // One-time reset all users to no subscription when RUN_SUBSCRIPTION_RESET=true (unset after running)
  try {
    await storage.runSubscriptionResetIfRequested();
  } catch (err) {
    console.error("Subscription reset (RUN_SUBSCRIPTION_RESET) failed; server continuing:", err);
  }

  // Hidden by default: set ENABLE_ADMIN_GENERATED_QUESTIONS_UI=true to expose. Admin: list generated draft questions (requires admin code; no auth)
  if (process.env.ENABLE_ADMIN_GENERATED_QUESTIONS_UI === "true") {
    app.get("/api/admin/generated-questions", async (req: any, res) => {
      if (!requireAdminCode(req)) {
        return res.status(403).json({ message: "Invalid admin code." });
      }
      try {
        const drafts = await storage.getDraftGeneratedQuestions();
        res.json(drafts);
      } catch (error) {
        console.error("Error fetching draft questions:", error);
        res.status(500).json({ message: "Failed to fetch draft questions." });
      }
    });
    app.post("/api/admin/generate-questions", async (req: any, res) => {
      if (!requireAdminCode(req)) {
        return res.status(403).json({ message: "Invalid admin code." });
      }
      try {
        const { runQuestionGenerationJob } = await import("./jobs/questionGenerationJob");
        const result = await runQuestionGenerationJob();
        res.json(result);
      } catch (error) {
        console.error("Error running question generation:", error);
        res.status(500).json({
          message: "Question generation failed.",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const { questionMediaUpload, publicQuestionImageUrl } = await import("./questionMediaUpload");
    app.post(
      "/api/admin/question-media",
      questionMediaUpload.single("file"),
      async (req: any, res) => {
        if (!requireAdminCode(req)) {
          return res.status(403).json({ message: "Invalid admin code." });
        }
        try {
          if (!req.file) {
            return res.status(400).json({ message: "Missing file upload." });
          }
          const url = publicQuestionImageUrl(req.file.filename);
          res.status(201).json({ url, filename: req.file.filename });
        } catch (error) {
          console.error("Error uploading question media:", error);
          res.status(500).json({
            message: error instanceof Error ? error.message : "Upload failed.",
          });
        }
      }
    );
  }

  // Admin: set user tester status (beta access to Atlas Trainer). Requires X-Admin-Code.
  app.patch("/api/admin/users/:userId/tester", async (req: any, res) => {
    if (!requireAdminCode(req)) {
      return res.status(403).json({ message: "Invalid admin code." });
    }
    const { userId } = req.params;
    const tester = req.body?.tester;
    if (typeof tester !== "boolean") {
      return res.status(400).json({ message: "Body must include { tester: true | false }." });
    }
    try {
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }
      const updated = await storage.updateUserTester(userId, tester);
      res.json(sanitizeUser(updated));
    } catch (error) {
      console.error("Error updating user tester status:", error);
      res.status(500).json({ message: "Failed to update tester status." });
    }
  });

  // External: list valid subsection IDs (for import UI). Requires QUESTION_IMPORT_API_KEY.
  app.get("/api/admin/subsection-ids", async (req: any, res) => {
    if (!requireImportApiKey(req)) {
      return res.status(403).json({
        message: "Invalid or missing API key. Set Authorization: Bearer <QUESTION_IMPORT_API_KEY> or X-API-Key header.",
      });
    }
    const subsections = subsectionOrder.map((id) => ({
      id,
      title: subsectionTitles[id] ?? id,
    }));
    res.json({
      subsectionIds: subsectionOrder,
      subsections,
      data: { ids: subsectionOrder },
    });
  });

  // External: import an approved question from another app (e.g. external question generator). Requires QUESTION_IMPORT_API_KEY.
  app.post("/api/admin/import-question", async (req: any, res) => {
    if (!requireImportApiKey(req)) {
      return res.status(403).json({
        message: "Invalid or missing API key. Set Authorization: Bearer <QUESTION_IMPORT_API_KEY> or X-API-Key header.",
      });
    }
    try {
      const validationResult = insertQuestionSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          message: "Invalid request data.",
          errors: validationResult.error.flatten().fieldErrors,
        });
      }
      const data = validationResult.data;
      const visible = typeof req.body.visible === "boolean" ? req.body.visible : undefined;
      if (data.source === "generated") {
        const formatResult = validateQuestionFormat(data.question, data.answer);
        if (!formatResult.valid) {
          return res.status(400).json({
            message: "Generated question failed format validation.",
            errors: formatResult.errors,
          });
        }
        const contentResult = contentRulesForGenerated(data.question);
        if (!contentResult.pass) {
          return res.status(400).json({
            message: contentResult.reason ?? "Generated question failed content rules.",
          });
        }
      }
      const { id } = await storage.createQuestion({ ...data, visible });
      res.status(201).json({ id });
    } catch (error) {
      console.error("Error importing question:", error);
      res.status(500).json({ message: "Failed to import question." });
    }
  });

  // Full question bank — entitled subscribers only (never ship stems/answers to anonymous clients)
  app.get('/api/sections', isAuthenticated, async (req: any, res) => {
    try {
      const specialtyId = await resolveRequestSpecialty(req);
      const userId = req.session?.userId as string;
      if (await specialtyIsLocked(userId, specialtyId)) {
        return res.status(403).json({ message: "An active subscription is required to access the question bank." });
      }
      const sections = await storage.getSections(specialtyId);
      res.json(sections);
    } catch (error) {
      console.error("Error fetching sections:", error);
      res.status(500).json({ message: "Failed to fetch sections." });
    }
  });

  // Marketing outline: section/subsection titles + counts only (no stems or answers)
  app.get('/api/sections/meta', async (req: any, res) => {
    try {
      const specialtyId = await resolveRequestSpecialty(req);
      const meta = await storage.getSectionsMeta(specialtyId);
      res.json(meta);
    } catch (error) {
      console.error("Error fetching sections meta:", error);
      res.status(500).json({ message: "Failed to fetch sections meta." });
    }
  });

  // Public 20-question preview sample (capped server-side; never the full bank)
  app.get('/api/preview/questions', async (req: any, res) => {
    try {
      const specialtyId = await resolveRequestSpecialty(req);
      const questions = await storage.getPreviewQuestions(specialtyId);
      res.json(questions);
    } catch (error) {
      console.error("Error fetching preview questions:", error);
      res.status(500).json({ message: "Failed to fetch preview questions." });
    }
  });

  /**
   * Specialty context for the client: which q-bank the host implies, which one is active, and
   * whether each one is unlocked (drives the switcher and the themed paywall).
   */
  app.get('/api/specialty', async (req: any, res) => {
    try {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      const hostSpecialty = getSpecialtyForHost(requestHostname(req));
      const available = SPECIALTY_LIST.map((s) => ({
        id: s.id,
        specialtyName: s.specialtyName,
        brandName: s.brandName,
        shortName: s.shortName,
      }));

      const userId = req.session?.userId;
      if (!userId) {
        return res.json({
          hostSpecialty,
          activeSpecialty: hostSpecialty,
          available,
          entitlements: [],
        });
      }

      let activeSpecialty = await storage.getActiveSpecialty(userId);
      const hostname = requestHostname(req);
      if (isKnownSpecialtyHost(hostname) && activeSpecialty !== hostSpecialty) {
        // Stay on this host's q-bank in the response, but do not overwrite the
        // stored selection here. A GET with a stale X-Forwarded-Host used to
        // pin PRS right after an Ortho login.
        activeSpecialty = hostSpecialty;
      }
      const entitlements = await Promise.all(
        SPECIALTY_LIST.map(async (s) => ({
          specialtyId: s.id,
          isLocked: await specialtyIsLocked(userId, s.id),
        }))
      );

      res.json({ hostSpecialty, activeSpecialty, available, entitlements });
    } catch (error) {
      console.error("Error resolving specialty context:", error);
      res.status(500).json({ message: "Failed to resolve specialty." });
    }
  });

  app.post('/api/specialty/active', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const requested = req.body?.specialtyId;
      if (!isSpecialtyId(requested)) {
        return res.status(400).json({ message: "A valid specialtyId is required." });
      }
      const activeSpecialty = await storage.setActiveSpecialty(userId, requested);
      res.json({
        activeSpecialty,
        isLocked: await specialtyIsLocked(userId, activeSpecialty),
      });
    } catch (error) {
      console.error("Error switching specialty:", error);
      res.status(500).json({ message: "Failed to switch question bank." });
    }
  });

  // Create AI-generated question (authenticated; same path used by scheduled job)
  app.post('/api/questions', isAuthenticated, async (req: any, res) => {
    try {
      const validationResult = insertQuestionSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          message: "Invalid request data.",
          errors: validationResult.error.flatten().fieldErrors,
        });
      }
      const data = validationResult.data;
      if (data.source === "generated") {
        const formatResult = validateQuestionFormat(data.question, data.answer);
        if (!formatResult.valid) {
          return res.status(400).json({
            message: "Generated question failed format validation.",
            errors: formatResult.errors,
          });
        }
        const contentResult = contentRulesForGenerated(data.question);
        if (!contentResult.pass) {
          return res.status(400).json({
            message: contentResult.reason ?? "Generated question failed content rules.",
          });
        }
      }
      const { id } = await storage.createQuestion(data);
      res.status(201).json({ id });
    } catch (error) {
      console.error("Error creating question:", error);
      res.status(500).json({ message: "Failed to create question." });
    }
  });

  // Update question content, visibility, media, or content-audit flag. Admin only:
  // these changes affect what every learner sees, so being signed in is not sufficient.
  app.patch('/api/questions/:id', async (req: any, res) => {
    if (!requireAdminCode(req)) {
      return res.status(401).json({ message: "Unauthorized." });
    }
    try {
      const { id } = req.params;
      const {
        question: questionText,
        answer,
        rationale,
        visible,
        flagged,
        imageUrl,
        imageAlt,
      } = req.body ?? {};

      if (questionText !== undefined || answer !== undefined) {
        if (typeof questionText !== "string" || typeof answer !== "string") {
          return res.status(400).json({ message: "question and answer must both be strings." });
        }
        const nextQuestion = questionText.trim();
        const nextAnswer = answer.trim();
        if (!nextQuestion || !nextAnswer) {
          return res.status(400).json({ message: "question and answer cannot be empty." });
        }
        if (rationale !== undefined && typeof rationale !== "string") {
          return res.status(400).json({ message: "rationale must be a string." });
        }
        const formatResult = validateQuestionFormat(nextQuestion, nextAnswer);
        if (!formatResult.valid) {
          return res.status(400).json({
            message: "Question failed format validation.",
            errors: formatResult.errors,
          });
        }
        const existing = await storage.getQuestion(id);
        if (!existing) {
          return res.status(404).json({ message: "Question not found." });
        }
        if (existing.question === nextQuestion && existing.answer === nextAnswer) {
          return res.json({ id, question: nextQuestion, answer: nextAnswer, unchanged: true });
        }
        await storage.createQuestionRevision({
          questionId: id,
          action: "revise",
          previousQuestion: existing.question,
          previousAnswer: existing.answer,
          newQuestion: nextQuestion,
          newAnswer: nextAnswer,
          source: "admin",
          rationale: typeof rationale === "string" ? rationale.trim() || null : null,
          reportIds: [],
        });
        const ok = await storage.updateQuestionText(id, nextQuestion, nextAnswer);
        if (!ok) {
          return res.status(500).json({ message: "Failed to update question content." });
        }
        return res.json({ id, question: nextQuestion, answer: nextAnswer });
      }

      if (imageUrl !== undefined || imageAlt !== undefined) {
        if (imageUrl !== undefined && imageUrl !== null && typeof imageUrl !== "string") {
          return res.status(400).json({ message: "imageUrl must be a string or null." });
        }
        if (imageAlt !== undefined && imageAlt !== null && typeof imageAlt !== "string") {
          return res.status(400).json({ message: "imageAlt must be a string or null." });
        }
        const question = await storage.getQuestion(id);
        if (!question) {
          return res.status(404).json({ message: "Question not found." });
        }
        const nextUrl = imageUrl === undefined ? question.imageUrl ?? null : imageUrl;
        const nextAlt = imageAlt === undefined ? question.imageAlt ?? null : imageAlt;
        const ok = await storage.updateQuestionImage(id, nextUrl, nextAlt);
        if (!ok) {
          return res.status(500).json({ message: "Failed to update question image." });
        }
        return res.json({ id, imageUrl: nextUrl, imageAlt: nextAlt });
      }

      if (typeof flagged === "boolean") {
        if (flagged) {
          const ok = await storage.flagQuestion(id, "admin-flagged");
          if (!ok) return res.status(404).json({ message: "Question not found." });
          return res.json({ id, flagged: true, visible: false });
        }
        const ok = await storage.unflagQuestion(id);
        if (!ok) return res.status(404).json({ message: "Question not found." });
        const refreshed = await storage.getQuestion(id);
        return res.json({ id, flagged: false, visible: refreshed?.visible ?? true });
      }

      if (typeof visible !== "boolean") {
        return res.status(400).json({
          message:
            "Body must include question/answer, visible: boolean, flagged: boolean, and/or imageUrl/imageAlt.",
        });
      }
      const question = await storage.getQuestion(id);
      if (!question) {
        return res.status(404).json({ message: "Question not found." });
      }
      if (visible && question.flagged) {
        return res.status(400).json({
          message: "Cannot make this question visible while it is flagged. Unflag it first (flagged: false).",
        });
      }
      if (
        visible &&
        !question.imageUrl &&
        extractQuestionStem(question.question).toLowerCase().includes("radiographic")
      ) {
        return res.status(400).json({
          message: 'Cannot make this question visible: stem contains "radiographic".',
        });
      }
      if (visible && !question.imageUrl && questionMcqChoicesReferenceSeeImage(question.question)) {
        return res.status(400).json({
          message:
            'Cannot make this question visible: an answer choice references an image (e.g. "see image").',
        });
      }
      const updated = await storage.updateQuestionVisibility(id, visible);
      if (!updated) {
        return res.status(500).json({ message: "Failed to update question." });
      }
      res.json({ id, visible });
    } catch (error) {
      console.error("Error updating question visibility:", error);
      res.status(500).json({ message: "Failed to update question." });
    }
  });

  // Report question (stored in DB + Slack; works with or without auth)
  app.post('/api/report-question', async (req: any, res) => {
    try {
      const { questionId, message } = req.body ?? {};
      if (typeof questionId !== 'string' || !questionId.trim()) {
        return res.status(400).json({ message: 'Missing or invalid question ID.' });
      }
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ message: 'Please describe what is wrong with the question.' });
      }
      const MAX_MESSAGE = 2000;
      const trimmedMessage = message.trim().slice(0, MAX_MESSAGE);
      const trimmedQuestionId = questionId.trim();
      let userEmail: string | null = null;
      const userId = req.session?.userId ?? null;
      if (userId) {
        const user = await storage.getUser(userId);
        userEmail = user?.email ?? null;
      }
      await storage.createQuestionReport({
        questionId: trimmedQuestionId,
        message: trimmedMessage,
        userEmail: userEmail ?? undefined,
        userId: userId ?? undefined,
      });
      const reportCount = await storage.countQuestionReportsForQuestion(trimmedQuestionId);
      let autoHidden = false;
      if (reportCount >= 10) {
        autoHidden = await storage.hideQuestionDueToReports(trimmedQuestionId);
        if (autoHidden) {
          console.log(
            `[report-question] Question ${trimmedQuestionId} auto-hidden (${reportCount} reports); reported flag set.`
          );
        }
      }
      const reported = await storage.getQuestionForReport(trimmedQuestionId);
      const slackFields = reported
        ? slackFieldsFromQuestion(reported.question, reported.answer)
        : { stem: null, choices: [], correctAnswer: null };
      await notifyQuestionReportSlack({
        questionId: trimmedQuestionId,
        message: trimmedMessage,
        userEmail,
        reportCount,
        autoHidden,
        databaseLabel: reported
          ? databaseLabelForSpecialty(reported.specialtyId)
          : isOrthoContentId(trimmedQuestionId)
            ? "Ortho database"
            : undefined,
        stem: slackFields.stem,
        choices: slackFields.choices,
        correctAnswer: slackFields.correctAnswer,
      });
      res.json({ message: 'Report sent.' });
    } catch (error) {
      console.error('Error sending question report:', error);
      res.status(500).json({ message: 'Failed to send report. Please try again later.' });
    }
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  app.post('/api/contact', supportFormRateLimiter, async (req: any, res) => {
    try {
      const { name, email, subject, message } = req.body ?? {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: 'Please enter your name.' });
      }
      if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
        return res.status(400).json({ message: 'Please enter a valid email address.' });
      }
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ message: 'Please enter a message.' });
      }
      const trimmedName = name.trim().slice(0, 200);
      const trimmedEmail = email.trim().slice(0, 320);
      const trimmedSubject =
        typeof subject === 'string' && subject.trim()
          ? subject.trim().slice(0, 200)
          : 'Website inquiry';
      const trimmedMessage = message.trim().slice(0, 5000);
      const specialty = getSpecialty(getSpecialtyForHost(requestHostname(req)));

      const [emailed, slacked] = await Promise.all([
        sendSupportContactEmail({
          toEmail: specialty.supportEmail,
          fromName: trimmedName,
          fromEmail: trimmedEmail,
          subject: trimmedSubject,
          message: trimmedMessage,
          specialtyLabel: specialty.brandName,
        }),
        notifySupportFormSlack({
          fromName: trimmedName,
          fromEmail: trimmedEmail,
          subject: trimmedSubject,
          message: trimmedMessage,
          specialtyLabel: specialty.brandName,
        }),
      ]);

      if (!emailed && !slacked) {
        return res.status(503).json({
          message: 'Messaging is temporarily unavailable. Please email us directly.',
        });
      }

      try {
        await storage.createContactMessage({
          name: trimmedName,
          email: trimmedEmail,
          subject: trimmedSubject,
          message: trimmedMessage,
          specialtyId: specialty.id,
        });
      } catch (persistErr) {
        console.error("Failed to persist contact message:", persistErr);
      }

      res.json({ message: 'Message sent.' });
    } catch (error) {
      console.error('Error sending support form:', error);
      res.status(500).json({ message: 'Failed to send message. Please try again later.' });
    }
  });

  app.post("/api/internal/feedback-agent", async (req: any, res) => {
    if (!requireFeedbackAgentSecret(req)) {
      return res.status(404).json({ message: "Not found." });
    }
    res.status(202).json({ message: "Feedback agent started." });
    import("./jobs/feedbackLearningJob")
      .then(({ runFeedbackLearningJob }) => runFeedbackLearningJob({ force: true }))
      .then((r) => console.log("[feedbackLearningJob] http trigger", r))
      .catch((e) => console.error("[feedbackLearningJob] http trigger error:", e));
  });

  app.post("/api/internal/too-easy-agent", async (req: any, res) => {
    if (!requireFeedbackAgentSecret(req)) {
      return res.status(404).json({ message: "Not found." });
    }
    res.status(202).json({ message: "Too-easy agent started." });
    import("./jobs/tooEasyQuestionsJob")
      .then(({ runTooEasyQuestionsJob }) => runTooEasyQuestionsJob({ force: true }))
      .then((r) => console.log("[tooEasyQuestionsJob] http trigger", r))
      .catch((e) => console.error("[tooEasyQuestionsJob] http trigger error:", e));
  });

  // Auth routes
  app.get('/api/auth/user', async (req: any, res) => {
    try {
      // Allow unauthenticated access - return null if not logged in
      const userId = req.session?.userId;
      if (!userId) {
        return res.json(null);
      }
      
      const user = await storage.getUser(userId);
      const sanitized = sanitizeUser(user);
      if (!sanitized) {
        return res.json(null);
      }
      // Intro trial is per specialty — use the q-bank the user is currently viewing.
      const activeSpecialtyId = await storage.getActiveSpecialty(userId);
      const introTrialAvailable = await storage.getIntroTrialEligibility(
        userId,
        activeSpecialtyId,
      );
      const tester = sanitized.tester === true || userHasAdminForeverAccess(user);
      res.json({ ...sanitized, tester, introTrialAvailable, activeSpecialtyId });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user." });
    }
  });

  // Update user profile (allowlist only — never accept passwordHash or other sensitive fields from body)
  const PROFILE_STRING_MAX = 255;
  const NAME_MAX = 100;
  const AVATAR_MAX = 50;
  app.patch('/api/auth/user', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized." });
      }
      const body = req.body ?? {};
      const updates: Record<string, string | undefined> = {};
      if (body.username !== undefined) {
        const v = typeof body.username === 'string' ? body.username.slice(0, PROFILE_STRING_MAX) : undefined;
        updates.username = v === '' ? undefined : v;
      }
      if (body.firstName !== undefined) {
        const v = typeof body.firstName === 'string' ? body.firstName.slice(0, NAME_MAX) : undefined;
        updates.firstName = v;
      }
      if (body.lastName !== undefined) {
        const v = typeof body.lastName === 'string' ? body.lastName.slice(0, NAME_MAX) : undefined;
        updates.lastName = v;
      }
      if (body.institutionalAffiliation !== undefined) {
        const v = typeof body.institutionalAffiliation === 'string' ? body.institutionalAffiliation.slice(0, PROFILE_STRING_MAX) : undefined;
        updates.institutionalAffiliation = v;
      }
      if (body.avatarIcon !== undefined) {
        const v = typeof body.avatarIcon === 'string' ? body.avatarIcon.slice(0, AVATAR_MAX) : undefined;
        updates.avatarIcon = v;
      }
      const updatedUser = await storage.updateUserProfile(userId, updates);
      res.json(sanitizeUser(updatedUser));
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ message: "Failed to update user." });
    }
  });

  // Tester redirect: create short-lived token and redirect to Atlas Trainer (train.prs-atlas.com)
  app.get("/api/auth/tester-redirect", async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        console.warn("[tester-redirect] 401: No session userId");
        return res.status(401).json({ message: "Unauthorized." });
      }
      const user = await storage.getUser(userId);
      if (!user) {
        console.warn("[tester-redirect] 401: User not found", { userId });
        return res.status(401).json({ message: "User not found." });
      }
      if (user.tester !== true && !userHasAdminForeverAccess(user)) {
        console.warn("[tester-redirect] 403: User is not a tester", { userId });
        return res.status(403).json({ message: "Beta testing access required." });
      }
      const token = createTesterRedirectToken(userId);
      const url = `${ATLAS_TRAINER_CALLBACK_URL}?token=${encodeURIComponent(token)}`;
      console.warn("[tester-redirect] 302 redirect to train with token", {
        urlPrefix: ATLAS_TRAINER_CALLBACK_URL,
        tokenLength: token.length,
        hasTokenInUrl: url.includes("token="),
      });
      res.redirect(302, url);
    } catch (error) {
      console.error("Error creating tester redirect:", error);
      res.status(500).json({ message: "Failed to create redirect." });
    }
  });

  // Verify tester token (called by train.prs-atlas.com). Returns user if token is valid and user is a tester.
  // Supports GET ?token=... and POST body { token } so train can avoid query-length/encoding issues.
  const TESTER_VERIFY_SECRET = process.env.TESTER_VERIFY_SECRET;
  const ATLAS_TRAINER_ORIGIN = "https://train.prs-atlas.com";

  const handleVerifyTesterToken = async (req: any, res: any) => {
    console.warn("[verify-tester-token] request received", {
      method: req.method,
      hasQueryToken: !!req.query?.token,
      hasBodyToken: !!(req.body?.token),
    });
    const token =
      (req.query.token as string | undefined) ||
      (req.body?.token as string | undefined);
    const tokenStr = typeof token === "string" ? token.trim() : undefined;

    if (TESTER_VERIFY_SECRET) {
      const secret = req.headers["x-tester-verify-secret"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (secret !== TESTER_VERIFY_SECRET) {
        console.warn("[verify-tester-token] 403: Invalid or missing verification secret");
        return res.status(403).json({ message: "Invalid or missing verification secret." });
      }
    }
    if (!tokenStr) {
      console.warn("[verify-tester-token] 400: Missing token");
      return res.status(400).json({ message: "Missing token." });
    }
    const payload = verifyTesterRedirectToken(tokenStr);
    if (!payload) {
      console.warn("[verify-tester-token] 401: Invalid or expired token");
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    const user = await storage.getUser(payload.userId);
    if (!user || (user.tester !== true && !userHasAdminForeverAccess(user))) {
      console.warn("[verify-tester-token] 403: User not found or not a tester", { userId: payload.userId });
      return res.status(403).json({ message: "User is not a tester." });
    }
    const base = sanitizeUser(user);
    const userOut =
      base && userHasAdminForeverAccess(user) ? { ...base, tester: true as const } : base;
    res.json({ valid: true, user: userOut });
  };

  app.get("/api/auth/verify-tester-token", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", ATLAS_TRAINER_ORIGIN);
    return handleVerifyTesterToken(req, res).catch(next);
  });
  app.post("/api/auth/verify-tester-token", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", ATLAS_TRAINER_ORIGIN);
    return handleVerifyTesterToken(req, res).catch(next);
  });
  app.options("/api/auth/verify-tester-token", (_req, res) => {
    res.set("Access-Control-Allow-Origin", ATLAS_TRAINER_ORIGIN);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Tester-Verify-Secret");
    res.set("Access-Control-Max-Age", "86400");
    res.sendStatus(204);
  });

  // Get user percentile rank for the active (or requested) question bank
  app.get('/api/user/percentile', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized." });
      }

      const specialtyId = await resolveRequestSpecialty(req);
      const percentile = await storage.getUserPercentileRank(userId, specialtyId);
      res.json({ percentile, specialtyId });
    } catch (error) {
      console.error("Error calculating percentile:", error);
      res.status(500).json({ message: "Failed to calculate percentile." });
    }
  });

  // Check subscription status for the active (or requested) question bank
  app.get('/api/subscription', async (req: any, res) => {
    try {
      // Never cache: browsers/proxies were returning 304 + stale "expired" after institutional redeem.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      const userId = req.session?.userId;
      if (!userId) {
        return res.json({ status: 'none', daysRemaining: 0, trialEndsAt: null, isLocked: false });
      }

      const specialtyId = await resolveRequestSpecialty(req);
      res.json(await computeSubscriptionState(userId, specialtyId));
    } catch (error) {
      console.error('Error checking subscription:', error);
      res.json({ status: 'error', daysRemaining: 0, trialEndsAt: null, isLocked: false });
    }
  });

  // Get user's login connections
  app.get('/api/auth/connections', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.json([]);
      }
      const connections = await storage.getLoginConnections(userId);
      res.json(connections.map(c => c.provider));
    } catch (error) {
      console.error("Error fetching connections:", error);
      res.status(500).json({ message: "Failed to fetch connections." });
    }
  });

  // Get user's theme preference
  app.get('/api/theme', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.json({ theme: 'light' });
      }
      const theme = await storage.getThemePreference(userId);
      res.json({ theme });
    } catch (error) {
      console.error("Error fetching theme preference:", error);
      res.json({ theme: 'light' });
    }
  });

  // Update user's theme preference
  app.post('/api/theme', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized." });
      }
      const { theme } = req.body;
      
      if (!theme || (theme !== 'light' && theme !== 'dark' && theme !== 'system')) {
        return res.status(400).json({ message: "Invalid theme." });
      }
      
      const updatedTheme = await storage.updateThemePreference(userId, theme);
      res.json({ theme: updatedTheme });
    } catch (error) {
      console.error("Error updating theme preference:", error);
      res.status(500).json({ message: "Failed to update theme preference." });
    }
  });

  // Add login connection
  app.post('/api/auth/connections/:provider', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized." });
      }
      const { provider } = req.params;
      
      await storage.addLoginConnection(userId, provider);
      res.json({ provider, added: true });
    } catch (error) {
      console.error("Error adding connection:", error);
      res.status(500).json({ message: "Failed to add connection." });
    }
  });

  // Remove login connection
  app.delete('/api/auth/connections/:provider', async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized." });
      }
      const { provider } = req.params;
      
      const connections = await storage.getLoginConnections(userId);
      if (connections.length <= 1) {
        return res.status(400).json({ message: "Cannot remove last connection." });
      }
      
      await storage.removeLoginConnection(userId, provider);
      res.json({ provider, removed: true });
    } catch (error) {
      console.error("Error removing connection:", error);
      res.status(500).json({ message: "Failed to remove connection." });
    }
  });

  // Test Session routes (all protected)
  app.get('/api/test-sessions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const sessions = await storage.getUserTestSessions(userId, specialtyId);
      res.json(sessions);
    } catch (error) {
      console.error("Error fetching test sessions:", error);
      res.status(500).json({ message: "Failed to fetch test sessions." });
    }
  });

  app.get('/api/test-sessions/in-progress', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const sessions = await storage.getInProgressSessions(userId, specialtyId);
      res.json(sessions);
    } catch (error) {
      console.error("Error fetching in-progress sessions:", error);
      res.status(500).json({ message: "Failed to fetch in-progress sessions." });
    }
  });

  app.get('/api/test-sessions/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const session = await storage.getTestSession(req.params.id);
      
      if (!session) {
        return res.status(404).json({ message: "Test session not found." });
      }
      
      if (session.userId !== userId) {
        return res.status(403).json({ message: "Forbidden." });
      }
      
      res.json(session);
    } catch (error) {
      console.error("Error fetching test session:", error);
      res.status(500).json({ message: "Failed to fetch test session." });
    }
  });

  app.post('/api/test-sessions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      
      // Validate request body
      const validationResult = insertTestSessionSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          message: "Invalid request data.",
          errors: validationResult.error.flatten().fieldErrors
        });
      }
      
      const specialtyId = await resolveRequestSpecialty(req);
      const sessionData = {
        ...validationResult.data,
        userId,
        specialtyId,
      };
      
      const session = await storage.createTestSession(sessionData as any);
      res.json(session);
    } catch (error) {
      console.error("Error creating test session:", error);
      res.status(500).json({ message: "Failed to create test session." });
    }
  });

  app.patch('/api/test-sessions/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const session = await storage.getTestSession(req.params.id);
      
      if (!session) {
        return res.status(404).json({ message: "Test session not found." });
      }
      
      if (session.userId !== userId) {
        return res.status(403).json({ message: "Forbidden." });
      }
      
      // Validate and whitelist allowed fields
      const validationResult = updateTestSessionSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          message: "Invalid request data.",
          errors: validationResult.error.errors 
        });
      }
      
      const updated = await storage.updateTestSession(req.params.id, validationResult.data);
      res.json(updated);
    } catch (error) {
      console.error("Error updating test session:", error);
      res.status(500).json({ message: "Failed to update test session." });
    }
  });

  app.post('/api/test-sessions/:id/complete', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const session = await storage.getTestSession(req.params.id);
      
      if (!session) {
        return res.status(404).json({ message: "Test session not found." });
      }
      
      if (session.userId !== userId) {
        return res.status(403).json({ message: "Forbidden." });
      }
      
      const completed = await storage.completeTestSession(req.params.id);
      res.json(completed);
    } catch (error) {
      console.error("Error completing test session:", error);
      res.status(500).json({ message: "Failed to complete test session." });
    }
  });

  app.delete('/api/test-sessions/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const session = await storage.getTestSession(req.params.id);
      
      if (!session) {
        return res.status(404).json({ message: "Test session not found." });
      }
      
      if (session.userId !== userId) {
        return res.status(403).json({ message: "Forbidden." });
      }
      
      await storage.deleteTestSession(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting test session:", error);
      res.status(500).json({ message: "Failed to delete test session." });
    }
  });

  // Question Response routes (all protected)
  app.post('/api/question-responses', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      
      // Validate request body
      const validationResult = insertQuestionResponseSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          message: "Invalid request data.",
          errors: validationResult.error.flatten().fieldErrors
        });
      }
      
      const { testSessionId } = validationResult.data;
      
      // Verify the test session belongs to the user (if testSessionId provided)
      if (testSessionId) {
        const session = await storage.getTestSession(testSessionId);
        if (!session || session.userId !== userId) {
          return res.status(403).json({ message: "Forbidden." });
        }
      }
      
      // Add userId to the response data before saving
      const responseData = {
        ...validationResult.data,
        userId
      };
      
      const response = await storage.upsertQuestionResponse(responseData);
      res.json(response);
    } catch (error) {
      console.error("Error saving question response:", error);
      res.status(500).json({ message: "Failed to save question response." });
    }
  });

  app.get('/api/test-sessions/:id/responses', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const session = await storage.getTestSession(req.params.id);
      
      if (!session) {
        return res.status(404).json({ message: "Test session not found." });
      }
      
      if (session.userId !== userId) {
        return res.status(403).json({ message: "Forbidden." });
      }
      
      const responses = await storage.getTestSessionResponses(req.params.id);
      res.json(responses);
    } catch (error) {
      console.error("Error fetching responses:", error);
      res.status(500).json({ message: "Failed to fetch responses." });
    }
  });

  // Notes endpoints
  app.get('/api/notes', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { sectionId, subsectionId } = req.query;
      const userNotes = await storage.getUserNotes(userId, sectionId as string, subsectionId as string);
      res.json(userNotes);
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ message: "Failed to fetch notes." });
    }
  });

  app.post('/api/notes', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { content, sectionId, subsectionId, location, questionId, positionX, positionY } = req.body;
      
      const note = await storage.createNote({
        userId,
        content,
        sectionId,
        subsectionId,
        location,
        questionId,
        positionX: positionX || 100,
        positionY: positionY || 100,
      });
      
      res.json(note);
    } catch (error) {
      console.error("Error creating note:", error);
      res.status(500).json({ message: "Failed to create note." });
    }
  });

  app.patch('/api/notes/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const noteId = req.params.id;
      const { content, positionX, positionY } = req.body;
      
      // Verify note belongs to user - need to get the note first
      const userNotes = await storage.getUserNotes(userId);
      const note = userNotes.find(n => n.id === noteId);
      
      if (!note) {
        return res.status(404).json({ message: "Note not found." });
      }
      
      const updates: any = {};
      if (content !== undefined) updates.content = content;
      if (positionX !== undefined) updates.positionX = positionX;
      if (positionY !== undefined) updates.positionY = positionY;
      
      const updatedNote = await storage.updateNote(noteId, updates);
      res.json(updatedNote);
    } catch (error) {
      console.error("Error updating note:", error);
      res.status(500).json({ message: "Failed to update note." });
    }
  });

  app.delete('/api/notes/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const noteId = req.params.id;
      
      // Verify note belongs to user
      const userNotes = await storage.getUserNotes(userId);
      const note = userNotes.find(n => n.id === noteId);
      
      if (!note) {
        return res.status(404).json({ message: "Note not found." });
      }
      
      await storage.deleteNote(noteId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting note:", error);
      res.status(500).json({ message: "Failed to delete note." });
    }
  });

  // Bookmarks routes
  app.get('/api/bookmarks', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const bookmarks = await storage.getUserBookmarks(userId, specialtyId);
      // Disable caching for bookmarks to ensure fresh data is always returned
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json(bookmarks);
    } catch (error) {
      console.error("Error fetching bookmarks:", error);
      res.status(500).json({ message: "Failed to fetch bookmarks." });
    }
  });

  app.post('/api/bookmarks', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { questionId, sectionId, subsectionId } = req.body;
      
      if (!questionId || !sectionId || !subsectionId) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      
      const bookmark = await storage.addBookmark({
        userId,
        questionId,
        sectionId,
        subsectionId,
      });
      
      res.json(bookmark);
    } catch (error) {
      console.error("Error adding bookmark:", error);
      res.status(500).json({ message: "Failed to add bookmark." });
    }
  });

  app.delete('/api/bookmarks/:questionId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const questionId = req.params.questionId;
      
      await storage.removeBookmark(userId, questionId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing bookmark:", error);
      res.status(500).json({ message: "Failed to remove bookmark." });
    }
  });

  app.get('/api/bookmarks/check/:questionId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const questionId = req.params.questionId;
      
      const isBookmarked = await storage.isQuestionBookmarked(userId, questionId);
      res.json({ isBookmarked });
    } catch (error) {
      console.error("Error checking bookmark:", error);
      res.status(500).json({ message: "Failed to check bookmark." });
    }
  });

  // Highlights routes
  app.get('/api/highlights', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const highlights = await storage.getUserHighlights(userId);
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json(highlights);
    } catch (error) {
      console.error("Error fetching highlights:", error);
      res.status(500).json({ message: "Failed to fetch highlights." });
    }
  });

  app.post('/api/highlights', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { text, color, sectionId, subsectionId, location, questionId, startOffset, endOffset } = req.body;
      
      if (!text || !sectionId || !subsectionId || !location || startOffset === undefined || endOffset === undefined) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      
      const highlight = await storage.createHighlight({
        userId,
        text,
        color: color || 'yellow',
        sectionId,
        subsectionId,
        location,
        questionId: questionId || null,
        startOffset,
        endOffset,
      });
      
      res.json(highlight);
    } catch (error) {
      console.error("Error creating highlight:", error);
      res.status(500).json({ message: "Failed to create highlight." });
    }
  });

  app.patch('/api/highlights/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const highlightId = req.params.id;
      const updates = req.body;
      
      // Verify highlight belongs to user
      const userHighlights = await storage.getUserHighlights(userId);
      const highlight = userHighlights.find(h => h.id === highlightId);
      
      if (!highlight) {
        return res.status(404).json({ message: "Highlight not found." });
      }
      
      const updatedHighlight = await storage.updateHighlight(highlightId, updates);
      res.json(updatedHighlight);
    } catch (error) {
      console.error("Error updating highlight:", error);
      res.status(500).json({ message: "Failed to update highlight." });
    }
  });

  app.delete('/api/highlights/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const highlightId = req.params.id;
      
      // Verify highlight belongs to user
      const userHighlights = await storage.getUserHighlights(userId);
      const highlight = userHighlights.find(h => h.id === highlightId);
      
      if (!highlight) {
        return res.status(404).json({ message: "Highlight not found." });
      }
      
      await storage.deleteHighlight(highlightId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting highlight:", error);
      res.status(500).json({ message: "Failed to delete highlight." });
    }
  });

  // Bulk sync highlights (for reconciling local and server data)
  app.post('/api/highlights/sync', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { highlights: localHighlights } = req.body;
      
      if (!Array.isArray(localHighlights)) {
        return res.status(400).json({ message: "Invalid highlights data." });
      }
      
      // Get server highlights
      const serverHighlights = await storage.getUserHighlights(userId);
      
      // Create new highlights that exist locally but not on server
      const createdHighlights = [];
      for (const local of localHighlights) {
        // Check if highlight already exists (by matching offsets and location)
        const exists = serverHighlights.some(s => 
          s.sectionId === local.sectionId &&
          s.subsectionId === local.subsectionId &&
          s.location === local.location &&
          s.startOffset === local.startOffset &&
          s.endOffset === local.endOffset
        );
        
        if (!exists) {
          const created = await storage.createHighlight({
            userId,
            text: local.text,
            color: local.color || 'yellow',
            sectionId: local.sectionId,
            subsectionId: local.subsectionId,
            location: local.location,
            questionId: local.questionId || null,
            startOffset: local.startOffset,
            endOffset: local.endOffset,
          });
          createdHighlights.push(created);
        }
      }
      
      // Return all highlights (merged)
      const allHighlights = await storage.getUserHighlights(userId);
      res.json(allHighlights);
    } catch (error) {
      console.error("Error syncing highlights:", error);
      res.status(500).json({ message: "Failed to sync highlights." });
    }
  });

  // Question Responses routes (study mode - without test session)
  app.get('/api/question-responses', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const responses = await storage.getUserQuestionResponses(userId, specialtyId);
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json(responses);
    } catch (error) {
      console.error("Error fetching question responses:", error);
      res.status(500).json({ message: "Failed to fetch question responses." });
    }
  });

  app.put('/api/question-responses/:questionId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const questionId = req.params.questionId;
      const { sectionId, subsectionId, selectedAnswer, correctAnswer, isCorrect } = req.body;
      
      if (!sectionId || !subsectionId || !selectedAnswer || isCorrect === undefined) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      
      const response = await storage.upsertStudyModeResponse(userId, {
        questionId,
        sectionId,
        subsectionId,
        selectedAnswer,
        correctAnswer: correctAnswer || '',
        isCorrect,
      });
      
      res.json(response);
    } catch (error) {
      console.error("Error saving question response:", error);
      res.status(500).json({ message: "Failed to save question response." });
    }
  });

  // Delete all question responses for user
  app.delete('/api/question-responses', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      await storage.deleteAllStudyModeResponses(userId);
      res.json({ message: "All responses deleted." });
    } catch (error) {
      console.error("Error deleting all question responses:", error);
      res.status(500).json({ message: "Failed to delete question responses." });
    }
  });

  // Bulk sync question responses (for reconciling local and server data)
  app.post('/api/question-responses/sync', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { responses: localResponses } = req.body;
      
      if (!Array.isArray(localResponses)) {
        return res.status(400).json({ message: "Invalid responses data." });
      }
      
      // Process each local response
      for (const local of localResponses) {
        if (local.questionId && local.sectionId && local.subsectionId && local.selectedAnswer !== undefined) {
          await storage.upsertStudyModeResponse(userId, {
            questionId: local.questionId,
            sectionId: local.sectionId,
            subsectionId: local.subsectionId,
            selectedAnswer: local.selectedAnswer,
            correctAnswer: local.correctAnswer || '',
            isCorrect: local.isCorrect || false,
          });
        }
      }
      
      // Return all responses (merged)
      const specialtyId = await resolveRequestSpecialty(req);
      const allResponses = await storage.getUserQuestionResponses(userId, specialtyId);
      res.json(allResponses);
    } catch (error) {
      console.error("Error syncing question responses:", error);
      res.status(500).json({ message: "Failed to sync question responses." });
    }
  });

  // Spaced Repetition routes
  app.get('/api/spaced-repetition/due', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const [dueQuestions, reviewedQuestionIds, incorrectQuestionIds] = await Promise.all([
        storage.getUserDueQuestions(userId, specialtyId),
        storage.getUserSpacedRepetitionQuestionIds(userId, specialtyId),
        storage.getUserIncorrectQuestionIds(userId, specialtyId),
      ]);
      res.json({
        due: dueQuestions,
        reviewedQuestionIds,
        incorrectQuestionIds,
      });
    } catch (error) {
      console.error("Error fetching due questions:", error);
      res.status(500).json({ message: "Failed to fetch due questions." });
    }
  });

  app.post('/api/spaced-repetition/update', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { questionId, sectionId, subsectionId, quality: rawQuality } = req.body;

      if (!questionId || rawQuality === undefined) {
        return res.status(400).json({ message: "Missing required fields." });
      }

      // Get existing SR data or create new
      let sr = await storage.getSpacedRepetition(userId, questionId);
      
      // Spaced intervals (comfortable for ~20 questions/day: fewer, longer intervals)
      const quality = Math.max(0, Math.min(5, rawQuality)); // 0-5 scale
      let repetitionCount = (sr?.repetitionCount || 0) + 1;
      let easeFactor = sr?.easeFactor || 2500;
      let interval = 1;

      if (quality >= 3) {
        // Correct or acceptable answer — space out more to avoid daily overload
        if (repetitionCount === 1) {
          interval = 3;   // first review in 3 days (was 1)
        } else if (repetitionCount === 2) {
          interval = 10;  // second review in 10 days (was 3)
        } else {
          const multiplier = Math.max(easeFactor / 100, 2.2); // grow at least 2.2x each time
          interval = Math.max(sr?.interval ?? 10, Math.round((sr?.interval || 10) * multiplier));
        }
      } else {
        // Incorrect or difficult answer - reset
        interval = 1;
        repetitionCount = 0;
      }

      // Update ease factor
      easeFactor = Math.max(1300, Math.round(easeFactor + (50 * quality - 150)));

      // Calculate next review date
      const nextReviewAt = new Date();
      nextReviewAt.setDate(nextReviewAt.getDate() + interval);

      const updatedSR = await storage.upsertSpacedRepetition({
        userId,
        questionId,
        sectionId: sectionId || '',
        subsectionId: subsectionId || '',
        repetitionCount,
        easeFactor,
        interval,
        nextReviewAt,
        lastReviewedAt: new Date(),
      });

      res.json(updatedSR);
    } catch (error) {
      console.error("Error updating spaced repetition:", error);
      res.status(500).json({ message: "Failed to update spaced repetition." });
    }
  });

  app.get('/api/spaced-repetition/:questionId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const questionId = req.params.questionId;
      
      const sr = await storage.getSpacedRepetition(userId, questionId);
      res.json(sr || { nextReviewAt: new Date() });
    } catch (error) {
      console.error("Error fetching SR data:", error);
      res.status(500).json({ message: "Failed to fetch SR data." });
    }
  });

  // Topic Analytics routes
  app.get('/api/analytics/topics', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const sectionId = req.query.sectionId as string | undefined;
      
      const topicStats = await storage.getTopicStats(userId, sectionId);
      res.json(topicStats);
    } catch (error) {
      console.error("Error fetching topic stats:", error);
      res.status(500).json({ message: "Failed to fetch topic stats." });
    }
  });

  // Subscription routes
  app.get('/api/subscription/plans', async (req: any, res) => {
    try {
      const specialtyId = await resolveRequestSpecialty(req);
      await storage.initializeSubscriptionPlans();
      const plans = await storage.getSubscriptionPlans(specialtyId);
      res.json(plans);
    } catch (error) {
      console.error("Error fetching subscription plans:", error);
      res.status(500).json({ message: "Failed to fetch subscription plans." });
    }
  });

  // Create Stripe Checkout Session (redirects user to Stripe's hosted checkout page)
  const { createCheckoutSession } = await import("./stripe");
  app.post('/api/subscription/checkout', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { planId } = req.body ?? {};
      if (!planId || typeof planId !== "string") {
        return res.status(400).json({ message: "Plan ID required." });
      }
      const user = await storage.getUser(userId);
      if (user && userHasAdminForeverAccess(user)) {
        return res.status(400).json({ message: "This account already has full access." });
      }
      const plan = await storage.getSubscriptionPlanById(planId.trim());
      if (!plan) {
        return res.status(400).json({ message: "Plan not found." });
      }
      const specialtyId = getSpecialty(plan.specialtyId).id;
      const introTrialEligible = await storage.getIntroTrialEligibility(userId, specialtyId);
      await storage.setPendingCheckoutPlan(userId, planId.trim(), specialtyId);
      const result = await createCheckoutSession({
        userId,
        userEmail: user?.email ?? null,
        planId: planId.trim(),
        introTrialEligible,
        requestOrigin: requestOrigin(req),
      });
      if ("error" in result) {
        return res.status(400).json({ message: result.error });
      }
      res.json({
        sessionUrl: result.url,
        specialtyId: result.specialtyId,
        /** True when the browser must hand off to the plan's specialty domain before Stripe. */
        requiresDomainHandoff:
          getSpecialtyForHost(requestHostname(req)) !== result.specialtyId,
      });
    } catch (error) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ message: "Failed to start checkout." });
    }
  });

  // Fulfill after Payment Link checkout (session_id; planId optional if pending checkout was stored)
  app.post("/api/subscription/fulfill", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const body = req.body ?? {};
      const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
      let planId = typeof body.planId === "string" ? body.planId.trim() : "";
      if (!sessionId) {
        return res.status(400).json({ message: "session_id required." });
      }
      if (!planId) {
        const pending = await storage.takePendingCheckoutPlan(userId);
        planId = pending?.planId ?? "";
      }
      if (!planId) {
        return res.status(400).json({ message: "session_id and planId required." });
      }
      const user = await storage.getUser(userId);
      if (user && userHasAdminForeverAccess(user)) {
        return res.status(400).json({ message: "This account already has full access." });
      }
      const { fulfillFromCheckoutSession } = await import("./stripe");
      const result = await fulfillFromCheckoutSession(sessionId, userId, planId);
      if ("error" in result) {
        return res.status(400).json({ message: result.error });
      }
      await storage.clearPendingCheckoutPlan(userId);
      res.json({ message: "Subscription activated." });
    } catch (error) {
      console.error("Error fulfilling subscription:", error);
      res.status(500).json({ message: "Failed to activate subscription." });
    }
  });

  // Get subscription details
  app.get('/api/subscription/details', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const { user, hasInstitutionalRedemption } = await loadUserForSubscription(userId, specialtyId);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      if (userHasAdminForeverAccess(user)) {
        const transactions = await storage.getUserSubscriptionTransactions(userId, specialtyId);
        return res.json({
          plan: "1-year",
          status: "active",
          endsAt: undefined,
          trialEndsAt: undefined,
          daysRemaining: null,
          transactionCount: transactions.length,
          planPrice: undefined,
        });
      }

      const institutionalExpiresAt = user.institutionalAccessExpiresAt
        ? new Date(user.institutionalAccessExpiresAt)
        : null;
      const hasInstitutional = institutionalAccessPeriodActive(hasInstitutionalRedemption, user, new Date());
      const activeSubscription = await storage.getUserActiveSubscription(userId, specialtyId);
      const now = new Date();

      /**
       * Show institutional plan/price when a code grants access, unless the user row shows a real ongoing
       * personal subscription/trial (avoids stale completed transactions forcing a wrong plan label + broken days).
       */
      if (hasInstitutional && !userHasCoherentPersonalPaidRow(user, now)) {
        const daysRemaining = institutionalDaysRemaining(institutionalExpiresAt, now);
        const txs = await storage.getUserSubscriptionTransactions(userId, specialtyId);
        /** Match GET /api/subscription/transactions: synthetic institutional row + Stripe-backed rows only when filtering legacy rows. */
        const stripeBackedCount = txs.filter(
          (t) => !!(t.stripePaymentIntentId?.trim() || t.stripeInvoiceId?.trim())
        ).length;
        const transactionCountForHistory = 1 + stripeBackedCount;
        const grant = await storage.getLatestInstitutionalCodeGrant(userId, specialtyId);
        const isTrialGrant = grant?.codeType === "trial";
        return res.json({
          plan: isTrialGrant ? "30-day-trial" : "institutional",
          status: "institutional",
          institutionalAffiliation: user?.institutionalAccessAffiliation?.trim() ?? "",
          endsAt: institutionalExpiresAt ? institutionalExpiresAt.toISOString() : undefined,
          trialEndsAt: isTrialGrant && institutionalExpiresAt ? institutionalExpiresAt.toISOString() : undefined,
          daysRemaining,
          transactionCount: transactionCountForHistory,
          grantKind: isTrialGrant ? "trial" : "institutional",
        });
      }

      const transactions = await storage.getUserSubscriptionTransactions(userId, specialtyId);
      const plans = await storage.getSubscriptionPlans(specialtyId);

      // Legacy plan names (DB may have old values): normalize for display and persist
      const LEGACY_PLAN_MAP: Record<string, string> = { '3-month': '1-year', '1-month': 'monthly' };
      const rawPlan = user?.subscriptionPlan;
      let planForDisplay = rawPlan;
      if (rawPlan && LEGACY_PLAN_MAP[rawPlan]) {
        planForDisplay = LEGACY_PLAN_MAP[rawPlan];
        await storage.updateSpecialtyEntitlement(userId, specialtyId, {
          subscriptionPlan: planForDisplay,
        });
      }
      // Prefer plan from latest active transaction (reflects actual purchase)
      if (activeSubscription?.planId) {
        const txPlan = plans.find((p) => p.id === activeSubscription.planId);
        if (txPlan) {
          planForDisplay = txPlan.name;
          if (rawPlan !== txPlan.name) {
            await storage.updateSpecialtyEntitlement(userId, specialtyId, {
              subscriptionPlan: txPlan.name,
            });
          }
        }
      }

      let status = user?.subscriptionStatus || 'trial';
      const trialEndsAt = user?.trialEndsAt ? new Date(user.trialEndsAt) : null;
      const userEndsAt = user?.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
      const activeEndDate = activeSubscription?.endDate ? new Date(activeSubscription.endDate) : null;
      const hasFutureAccess = (userEndsAt && userEndsAt.getTime() > now.getTime()) || (activeEndDate && activeEndDate.getTime() > now.getTime());
      const cancelAtPeriodEnd = user.subscriptionCancelAtPeriodEnd === true;

      // If trial period has ended, treat as active for display
      if (status === 'trial' && trialEndsAt && trialEndsAt.getTime() <= now.getTime()) {
        status = 'active';
      }
      if (cancelAtPeriodEnd && hasFutureAccess) {
        status = 'canceled';
      } else if (cancelAtPeriodEnd && !hasFutureAccess) {
        status = 'expired';
        await storage.updateSpecialtyEntitlement(userId, specialtyId, {
          subscriptionStatus: 'expired',
          subscriptionCancelAtPeriodEnd: false,
        });
      }

      let daysRemaining: number | null = null;
      let endsAt: string | undefined;

      if (status === 'trial' && trialEndsAt) {
        daysRemaining = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
        endsAt = undefined;
      } else {
        const futureCandidates: Date[] = [];
        if (userEndsAt && userEndsAt.getTime() > now.getTime()) futureCandidates.push(userEndsAt);
        if (activeEndDate && activeEndDate.getTime() > now.getTime()) futureCandidates.push(activeEndDate);
        const bestEnd =
          futureCandidates.length > 0
            ? futureCandidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
            : null;
        if (bestEnd && (status === 'active' || status === 'canceled' || status === 'trial')) {
          daysRemaining = Math.max(0, Math.ceil((bestEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
          endsAt = bestEnd.toISOString();
        } else if (activeSubscription?.endDate) {
          const endDate = new Date(activeSubscription.endDate);
          daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
          endsAt = endDate.toISOString();
        } else {
          endsAt = undefined;
        }
      }

      let planPrice: number | undefined;
      if (planForDisplay && planForDisplay !== 'institutional') {
        const plan = plans.find((p) => p.name === planForDisplay);
        if (plan) planPrice = plan.priceUSD;
      }

      res.json({
        plan: planForDisplay,
        status,
        endsAt,
        trialEndsAt: trialEndsAt?.toISOString() ?? undefined,
        daysRemaining,
        transactionCount: transactions.length,
        planPrice,
      });
    } catch (error) {
      console.error("Error fetching subscription details:", error);
      res.status(500).json({ message: "Failed to fetch subscription details." });
    }
  });

  // Subscription transaction history (with Stripe receipt / hosted invoice URLs when available)
  app.get("/api/subscription/transactions", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const { user, hasInstitutionalRedemption } = await loadUserForSubscription(userId, specialtyId);
      if (!user) {
        return res.json({ transactions: [] });
      }

      const now = new Date();
      const txs = await storage.getUserSubscriptionTransactions(userId, specialtyId);
      const plans = await storage.getSubscriptionPlans(specialtyId);
      const planNameById = new Map(plans.map((p) => [p.id, p.name]));
      const { getReceiptOrInvoiceUrlForTransaction } = await import("./stripe");

      const instExp = user.institutionalAccessExpiresAt ? new Date(user.institutionalAccessExpiresAt) : null;
      const institutionalActive = institutionalAccessPeriodActive(hasInstitutionalRedemption, user, now);
      const personalCoherent = userHasCoherentPersonalPaidRow(user, now);

      const planById = new Map(plans.map((p) => [p.id, p]));

      let transactions = await Promise.all(
        txs.map(async (t) => {
          const hasStripeIds = !!(t.stripePaymentIntentId?.trim() || t.stripeInvoiceId?.trim());
          const stripeReceiptOrInvoiceUrl = await getReceiptOrInvoiceUrlForTransaction(
            t.stripePaymentIntentId,
            t.stripeInvoiceId
          );
          const planRow = planById.get(t.planId);
          return {
            id: t.id,
            planName: planNameById.get(t.planId) ?? t.planId,
            planDurationMonths: planRow?.durationMonths ?? null,
            amountCents: t.amount,
            status: t.status,
            createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
            periodStart: t.startDate ? new Date(t.startDate).toISOString() : null,
            periodEnd: t.endDate ? new Date(t.endDate).toISOString() : null,
            canceledAt: t.canceledAt ? new Date(t.canceledAt).toISOString() : null,
            stripeReceiptOrInvoiceUrl,
            hasStripeIds,
            isInstitutionalGrant: false,
            isTrialPeriod: false,
            isTrialCodeGrant: false,
          };
        })
      );

      /**
       * Normalize current trial display:
       * - Initial checkout rows may contain full-plan amount/period from Stripe subscription metadata.
       * - While user is in active trial, show that row as a 7-day $0.00 trial window.
       */
      const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
      const inActiveTrial =
        (user.subscriptionStatus || "").toLowerCase() === "trial" &&
        trialEndsAt !== null &&
        trialEndsAt.getTime() > now.getTime();
      if (inActiveTrial && trialEndsAt) {
        const trialStart = new Date(trialEndsAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const trialEndIso = trialEndsAt.toISOString();
        const trialCandidate = transactions.find(
          (row) =>
            !row.isInstitutionalGrant &&
            !!row.hasStripeIds &&
            row.planDurationMonths === 1 &&
            (row.status || "").toLowerCase() === "completed"
        );
        if (trialCandidate) {
          trialCandidate.amountCents = 0;
          trialCandidate.periodStart = trialStart;
          trialCandidate.periodEnd = trialEndIso;
          trialCandidate.isTrialPeriod = true;
        }
      }

      /**
       * Hide legacy non-Stripe DB rows (e.g. from /subscription/change) when access is only institutional —
       * they show wrong plan/amount vs. code-based access.
       */
      if (institutionalActive && !personalCoherent) {
        transactions = transactions.filter((row) => row.hasStripeIds);
      }

      if (hasInstitutionalRedemption) {
        const grant = await storage.getLatestInstitutionalCodeGrant(userId, specialtyId);
        const isTrialGrant = grant?.codeType === "trial";
        const durationDays = accessDurationDaysForCodeType(grant?.codeType ?? "institutional");
        const aff =
          (user.institutionalAccessAffiliation ?? "").trim() ||
          (isTrialGrant ? "30-Day Trial" : "Institutional Access");
        const institutionalEndIso = instExp
          ? instExp.toISOString()
          : user.updatedAt
            ? new Date(user.updatedAt).toISOString()
            : null;
        const redeemedStartIso = grant?.redeemedAt ? new Date(grant.redeemedAt).toISOString() : null;
        const institutionalPeriodStartIso =
          redeemedStartIso ??
          (institutionalEndIso != null
            ? new Date(
                new Date(institutionalEndIso).getTime() - durationDays * 24 * 60 * 60 * 1000,
              ).toISOString()
            : null);
        const institutionalCanceled =
          !institutionalActive &&
          (!!institutionalEndIso ? new Date(institutionalEndIso).getTime() <= now.getTime() : true);
        transactions.unshift({
          id: "__institutional_access__",
          planName: aff,
          planDurationMonths: null,
          amountCents: 0,
          status: institutionalCanceled ? "canceled" : "completed",
          createdAt: null,
          periodStart: institutionalPeriodStartIso,
          periodEnd: institutionalEndIso,
          canceledAt: institutionalCanceled ? institutionalEndIso : null,
          stripeReceiptOrInvoiceUrl: null,
          hasStripeIds: false,
          isInstitutionalGrant: true,
          isTrialPeriod: false,
          isTrialCodeGrant: isTrialGrant,
        });
      }

      res.json({ transactions });
    } catch (error) {
      console.error("Error fetching subscription transactions:", error);
      res.status(500).json({ message: "Failed to fetch transactions." });
    }
  });

  // Change subscription plan
  app.post('/api/subscription/change', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const user = await storage.getUser(userId);
      if (user && userHasAdminForeverAccess(user)) {
        return res.status(400).json({ message: "This account already has full access." });
      }
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ message: "Plan ID required." });
      }

      const plan = await storage.getSubscriptionPlanById(planId);
      if (!plan) {
        return res.status(404).json({ message: "Plan not found." });
      }
      const specialtyId = getSpecialty(plan.specialtyId).id;
      const previousEntitlement = await storage.getSpecialtyEntitlement(userId, specialtyId);

      // Create transaction
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + plan.durationMonths);

      await storage.createSubscriptionTransaction({
        userId,
        planId,
        specialtyId,
        amount: plan.priceUSD,
        status: 'completed',
        startDate,
        endDate,
      });

      // Update the entitlement for the plan's q-bank only; the other bank is untouched.
      await storage.updateSpecialtyEntitlement(userId, specialtyId, {
        subscriptionStatus: 'active',
        subscriptionPlan: plan.name,
        subscriptionEndsAt: endDate,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionCanceledAt: null,
        subscriptionTrialUsed: true,
      });

      scheduleSlackNotify(() =>
        notifyPlanPurchaseSlack({
          email: user?.email,
          firstName: user?.firstName,
          lastName: user?.lastName,
          specialtyId,
          planName: plan.name,
          previousPlanName: previousEntitlement.subscriptionPlan,
          previousStatus: previousEntitlement.subscriptionStatus,
          amountCents: plan.priceUSD,
          durationMonths: plan.durationMonths,
          source: "In-app plan change",
          idempotencyKey: `change:${userId}:${specialtyId}:${plan.id}:${startDate.toISOString()}`,
        })
      );

      res.json({ message: "Subscription updated successfully." });
    } catch (error) {
      console.error("Error changing subscription:", error);
      res.status(500).json({ message: "Failed to change subscription." });
    }
  });

  // Cancel subscription (institutional: ends instantly; paid: immediate Stripe + Atlas end, no further charges).
  // User data (progress, notes, bookmarks, etc.) is never deleted; re-subscribing restores full access to the same account.
  app.post('/api/subscription/cancel', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const specialtyId = await resolveRequestSpecialty(req);
      const user = await storage.getUserWithSpecialtyEntitlement(userId, specialtyId);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      if (userHasAdminForeverAccess(user)) {
        return res.json({
          message: "This account has permanent complimentary access; nothing to cancel.",
          removedInstitutional: false,
        });
      }

      const now = new Date();

      /**
       * Institutional-primary users (subscription UI shows "Remove access") must clear code access here first.
       * Otherwise stale completed transactions make userHasPersonalSubscriptionAccess true, we run Stripe cancel,
       * return the wrong toast, and leave institutional fields intact — user keeps access.
       */
      const hasRedemption = await storage.userHasAnyInstitutionalRedemption(userId, specialtyId);
      const institutionalActive = institutionalAccessPeriodActive(hasRedemption, user, now);
      if (institutionalActive || (await userIsInstitutionalPrimaryAccess(userId, user, now, specialtyId))) {
        const grant = await storage.getLatestInstitutionalCodeGrant(userId, specialtyId);
        const isTrialGrant = grant?.codeType === "trial";
        const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const newStatus = trialEndsAt && trialEndsAt > now ? "trial" : "expired";
        await storage.updateSpecialtyEntitlement(userId, specialtyId, {
          institutionalAccessAffiliation: null,
          /** Keep cancellation timestamp for transaction-history period end. */
          institutionalAccessExpiresAt: now,
          subscriptionStatus: newStatus,
        });
        return res.json({
          message: isTrialGrant
            ? "Trial access ended. You can still start a 7-day free trial when you subscribe for the first time."
            : "Institutional access removed. Subscribe for personal access, or redeem a different institution code if your program provides one.",
          removedInstitutional: true,
        });
      }

      const activeTx = await storage.getUserActiveSubscription(userId, specialtyId);
      if (userHasPersonalSubscriptionAccess(user, activeTx)) {
        const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const inActiveTrial =
          (user.subscriptionStatus || "").toLowerCase() === "trial" &&
          !!trialEndsAt &&
          trialEndsAt.getTime() > now.getTime();
        await storage.cancelUserSubscription(userId, specialtyId);
        return res.json({
          message: inActiveTrial
            ? "Your free trial was canceled immediately. You will not be charged."
            : "Your subscription will end on your current period end date. You won't be charged again for this plan.",
        });
      }

      const hasInstitutionalFields = !!(
        user.institutionalAccessAffiliation?.trim() || user.institutionalAccessExpiresAt
      );
      if (hasRedemption || hasInstitutionalFields) {
        const grant = await storage.getLatestInstitutionalCodeGrant(userId, specialtyId);
        const isTrialGrant = grant?.codeType === "trial";
        const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const newStatus = trialEndsAt && trialEndsAt > now ? "trial" : "expired";
        await storage.updateSpecialtyEntitlement(userId, specialtyId, {
          institutionalAccessAffiliation: null,
          institutionalAccessExpiresAt: now,
          subscriptionStatus: newStatus,
        });
        return res.json({
          message: isTrialGrant
            ? "Trial access ended. You can still start a 7-day free trial when you subscribe for the first time."
            : "Institutional access removed. Subscribe for personal access, or redeem a different institution code if your program provides one.",
          removedInstitutional: true,
        });
      }

      await storage.cancelUserSubscription(userId, specialtyId);
      res.json({
        message:
          "Your subscription will end on your current period end date. You won't be charged again for this plan.",
      });
    } catch (error) {
      console.error("Error canceling subscription:", error);
      res.status(500).json({ message: "Failed to cancel subscription." });
    }
  });

  // Redeem institutional access code (codes stored hashed in DB; user gets institution display name)
  app.post('/api/subscription/institutional-code', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.session?.userId;
      const { code } = req.body;
      const raw = typeof code === 'string' ? code.trim() : '';
      if (!raw) {
        return res.status(400).json({ message: "Code is required." });
      }
      const lookupCode = normalizeInstitutionalCodeForLookup(raw);
      const resolved = await storage.resolveInstitutionalCode(lookupCode);
      if (resolved.type === "not_found") {
        return res.status(400).json({ message: "Invalid code." });
      }
      if (resolved.type === "exhausted") {
        return res.status(400).json({
          message: "This code has already been redeemed and can only be used once.",
        });
      }
      if (resolved.type === "inactive") {
        return res.status(400).json({
          message: "This code has been deactivated and can no longer be redeemed.",
        });
      }
      if (resolved.type === "redeem_expired") {
        return res.status(400).json({
          message:
            "This code is past its 90-day redemption window and can no longer be redeemed. If you already redeemed it, your access is unchanged.",
        });
      }
      if (await storage.hasUserRedeemedInstitutionalCode(userId, resolved.codeId)) {
        return res.status(400).json({
          message:
            resolved.codeType === "trial"
              ? "You have already redeemed this trial code on your account. Trial codes can only be used once per account."
              : "You have already redeemed this code on your account. Use a different code or subscribe for personal access.",
        });
      }
      if (resolved.codeType === "trial" && (await storage.hasUserRedeemedAnyTrialCode(userId))) {
        return res.status(400).json({
          message:
            "You have already redeemed a trial code on this account. Trial codes can only be used once per account. You can still start a 7-day free trial when you subscribe for the first time.",
        });
      }
      const expiresAt = institutionalAccessExpiresAtForRedemption(lookupCode, resolved.codeType);
      /** A code unlocks exactly one q-bank, so redeeming also makes that bank the active one. */
      const recorded = await storage.recordInstitutionalCodeRedemption(
        userId,
        resolved.codeId,
        resolved.specialtyId,
        {
          institutionName: resolved.institutionName,
          expiresAt,
        },
      );
      if (!recorded.ok) {
        return res.status(400).json({
          message:
            recorded.reason === "already_redeemed"
              ? "You have already redeemed this code on your account. Use a different code or subscribe for personal access."
              : "This code has already been redeemed and can only be used once.",
        });
      }
      await storage.setActiveSpecialty(userId, resolved.specialtyId);
      res.json({
        message: resolved.codeType === "trial" ? "30-day trial started." : "Access Granted!",
        specialtyId: resolved.specialtyId,
        grantKind: resolved.codeType,
      });
    } catch (error: any) {
      console.error("Error redeeming institutional code:", error);
      const message = process.env.NODE_ENV !== "production" && error?.message
        ? error.message
        : "Failed to redeem code.";
      res.status(500).json({ message });
    }
  });

  /**
   * Admin: institutional codes (header X-Admin-Code, same as other admin routes).
   * Many accounts may redeem the same code while it is active; PATCH active:false stops new redemptions only.
   */
  app.get("/api/admin/institutional-codes", async (req: any, res) => {
    if (!requireAdminCode(req)) {
      return res.status(403).json({ message: "Invalid admin code." });
    }
    try {
      const codes = await storage.getInstitutionalCodesAdmin();
      res.json({ codes });
    } catch (error) {
      console.error("Error listing institutional codes:", error);
      res.status(500).json({ message: "Failed to list codes." });
    }
  });

  app.post("/api/admin/institutional-codes", async (req: any, res) => {
    if (!requireAdminCode(req)) {
      return res.status(403).json({ message: "Invalid admin code." });
    }
    try {
      const plaintext = typeof req.body?.plaintextCode === "string" ? req.body.plaintextCode.trim() : "";
      const institutionName =
        typeof req.body?.institutionName === "string" ? req.body.institutionName.trim().slice(0, 200) : "";
      if (!plaintext || !institutionName) {
        return res.status(400).json({ message: "plaintextCode and institutionName are required." });
      }
      const codeSpecialtyId = req.body?.specialtyId;
      if (codeSpecialtyId != null && !isSpecialtyId(codeSpecialtyId)) {
        return res.status(400).json({ message: "specialtyId must be one of: prs, ortho." });
      }
      const codeType = parseInstitutionalCodeType(req.body?.codeType);
      /** A code unlocks exactly one q-bank; omitting specialtyId keeps the historical PRS behavior. */
      const { id, redeemExpiresAt } = await storage.createInstitutionalCodeAdmin(
        plaintext,
        institutionName,
        isSpecialtyId(codeSpecialtyId) ? codeSpecialtyId : DEFAULT_SPECIALTY_ID,
        codeType,
      );
      res.status(201).json({
        id,
        codeType,
        redeemExpiresAt: redeemExpiresAt.toISOString(),
        message:
          codeType === "trial"
            ? "Trial code created. It can be redeemed for 90 days from now. Each redemption grants 30 days of access (once per account) and does not use the 7-day Stripe intro trial. The plaintext code is not stored — copy it now."
            : "Code created and active. It can be redeemed for 90 days from now. The plaintext code is not stored — copy it now for the institution.",
      });
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      const msg = typeof err?.message === "string" ? err.message : "";
      if (err?.code === "23505" || msg.includes("unique") || msg.includes("duplicate")) {
        return res.status(409).json({ message: "This exact code already exists in the system." });
      }
      console.error("Error creating institutional code:", error);
      res.status(500).json({ message: "Failed to create code." });
    }
  });

  app.patch("/api/admin/institutional-codes/:id", async (req: any, res) => {
    if (!requireAdminCode(req)) {
      return res.status(403).json({ message: "Invalid admin code." });
    }
    try {
      const { id } = req.params;
      if (!id || typeof id !== "string") {
        return res.status(400).json({ message: "Invalid id." });
      }
      const active = req.body?.active;
      if (typeof active !== "boolean") {
        return res.status(400).json({ message: "JSON body must include active: true or false." });
      }
      const ok = await storage.setInstitutionalCodeActiveAdmin(id, active);
      if (!ok) {
        return res.status(404).json({ message: "Code not found." });
      }
      res.json({
        message: active
          ? "Code is marked active. It can be redeemed only while it is active and within 90 days of creation."
          : "Code deactivated. It can no longer be redeemed.",
      });
    } catch (error) {
      console.error("Error updating institutional code:", error);
      res.status(500).json({ message: "Failed to update code." });
    }
  });

  // Oral Board Simulator routes (sessions + messages persisted per user)
  const { createOpenAIThread, sendMessage, sendMessageWithStream } = await import('./oralBoardService');

  app.get('/api/oral-board/sessions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const sessions = await storage.listOralBoardSessionsForUser(userId);
      res.json({ sessions });
    } catch (error) {
      console.error('Error listing oral board sessions:', error);
      res.status(500).json({ message: 'Failed to load sessions.' });
    }
  });

  app.post('/api/oral-board/sessions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const openaiThreadId = await createOpenAIThread();
      const row = await storage.createOralBoardSession(userId, openaiThreadId);
      const sessions = await storage.listOralBoardSessionsForUser(userId);
      const meta = sessions.find((s) => s.id === row.id);
      res.json({
        id: row.id,
        openaiThreadId: row.openaiThreadId,
        title: meta?.title ?? 'Session 1',
        sessionNumber: meta?.sessionNumber ?? 1,
        messageCount: meta?.messageCount ?? 0,
      });
    } catch (error) {
      console.error('Error creating oral board session:', error);
      res.status(500).json({ message: 'Failed to create session.' });
    }
  });

  app.get('/api/oral-board/sessions/:sessionId/messages', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;
      const session = await storage.getOralBoardSessionForUser(userId, sessionId);
      if (!session) {
        return res.status(404).json({ message: 'Session not found.' });
      }
      const messages = await storage.listOralBoardMessagesForUser(userId, sessionId);
      res.json({ messages });
    } catch (error) {
      console.error('Error loading oral board messages:', error);
      res.status(500).json({ message: 'Failed to load messages.' });
    }
  });

  app.delete('/api/oral-board/sessions/:sessionId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;
      const ok = await storage.deleteOralBoardSessionForUser(userId, sessionId);
      if (!ok) return res.status(404).json({ message: 'Session not found.' });
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting oral board session:', error);
      res.status(500).json({ message: 'Failed to delete session.' });
    }
  });

  app.post('/api/oral-board/chat', isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const { sessionId, message, stream: wantStream } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ message: 'Missing sessionId or message.' });
    }

    const session = await storage.getOralBoardSessionForUser(userId, sessionId);
    if (!session) {
      return res.status(401).json({ message: 'Invalid session.' });
    }
    const threadId = session.openaiThreadId;

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as any).flushHeaders === 'function') {
        (res as any).flushHeaders();
      }

      const writeSse = (obj: object) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      try {
        await storage.addOralBoardMessage(sessionId, userId, 'user', message);
        const fullText = await sendMessageWithStream(threadId, message, (chunk) =>
          writeSse({ t: chunk })
        );
        await storage.addOralBoardMessage(sessionId, userId, 'assistant', fullText);
        writeSse({ done: true });
      } catch (error: any) {
        console.error('Error processing oral board chat stream:', error);
        const clientMessage =
          process.env.NODE_ENV !== 'production' && error?.message
            ? error.message
            : 'Failed to process message.';
        writeSse({ error: clientMessage });
      }
      return res.end();
    }

    try {
      await storage.addOralBoardMessage(sessionId, userId, 'user', message);
      const response = await sendMessage(threadId, message);
      await storage.addOralBoardMessage(sessionId, userId, 'assistant', response);
      res.json({ response });
    } catch (error: any) {
      console.error('Error processing chat message:', error);
      const clientMessage =
        process.env.NODE_ENV !== 'production' && error?.message
          ? error.message
          : 'Failed to process message.';
      res.status(500).json({ message: clientMessage });
    }
  });

  // Chat Bubble routes
  const { 
    initializeThread: initChatBubbleThread, 
    sendMessage: sendChatBubbleMessage, 
    validateThreadExists: validateChatBubbleThread 
  } = await import('./chatBubbleService');

  app.post('/api/chat-bubble/init', async (req: any, res) => {
    try {
      const threadId = await initChatBubbleThread();
      res.json({ threadId });
    } catch (error) {
      console.error('Error initializing chat bubble thread:', error);
      res.status(500).json({ message: 'Failed to initialize chat bubble session.' });
    }
  });

  app.post('/api/chat-bubble/chat', async (req: any, res) => {
    try {
      const { threadId, message } = req.body;

      if (!threadId || !message) {
        return res.status(400).json({ message: 'Missing threadId or message.' });
      }

      if (!validateChatBubbleThread(threadId)) {
        return res.status(401).json({ message: 'Invalid thread ID.' });
      }

      const response = await sendChatBubbleMessage(threadId, message);
      res.json({ response });
    } catch (error) {
      console.error('Error processing chat bubble message:', error);
      res.status(500).json({ message: 'Failed to process message.' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}