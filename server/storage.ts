import bcrypt from "bcrypt";
import {
  users,
  passwordResetTokens,
  testSessions,
  questionResponses,
  loginConnections,
  notes,
  highlights,
  bookmarks,
  spacedRepetitions,
  subscriptionPlans,
  subscriptionTransactions,
  institutionalCodes,
  userInstitutionalCodeRedemptions,
  questionReports,
  contactMessages,
  questionRevisions,
  agentJobRuns,
  agentLessons,
  agentFinetuneExamples,
  oralBoardSessions,
  oralBoardMessages,
  sections,
  subsections,
  questions,
  userSpecialtySubscriptions,
  authHandoffTokens,
  pendingCheckoutPlans,
  type User,
  type UpsertUser,
  type UserSpecialtySubscription,
  type TestSession,
  type InsertTestSession,
  type QuestionResponse,
  type InsertQuestionResponse,
  type LoginConnection,
  type Note,
  type InsertNote,
  type Highlight,
  type InsertHighlight,
  type Bookmark,
  type InsertBookmark,
  type SpacedRepetition,
  type InsertSpacedRepetition,
  type SubscriptionPlan,
  type InsertSubscriptionPlan,
  type SubscriptionTransaction,
  type InsertSubscriptionTransaction,
  type QuestionReport,
  type InsertQuestionReport,
  type ContactMessage,
  type InsertContactMessage,
  type QuestionRevision,
  type InsertQuestionRevision,
  type QuestionImageAttribution,
  type AgentJobRun,
  type AgentLesson,
  type InsertAgentLesson,
  type AgentFinetuneExample,
  type InsertAgentFinetuneExample,
  type OralBoardSession,
  type OralBoardMessage,
} from "@shared/schema";
import { extractQuestionStem, questionMcqChoicesReferenceSeeImage } from "@shared/questionFormat";
import { selectPreviewQuestions, PREVIEW_COUNT } from "@shared/previewQuestions";
import { subsectionTitles } from "@shared/questionImport";
import { orthoSubsectionTitles } from "@shared/orthoQuestionImport";
import {
  DEFAULT_SPECIALTY_ID,
  SPECIALTY_IDS,
  contentIdMatchesSpecialty,
  getSpecialty,
  isOrthoContentId,
  type SpecialtyId,
} from "@shared/specialties";
import { db, pool } from "./db";
import { eq, and, or, asc, desc, lte, gte, sql, count, inArray, like, notLike } from "drizzle-orm";
import {
  IOWA_TRIAL_CODE,
  NUMC_TRIAL_CODE,
  PRSATLAS30_CODE,
  SOCIALMEDIA_INSTITUTIONAL_CODE,
  TEMPLE_TRIAL_CODE,
  TRIAL_CODE_DURATION_DAYS,
  isCodeRedeemWindowOpen,
  normalizeInstitutionalCodeForLookup,
  parseInstitutionalCodeType,
  redeemExpiresAtFromCreatedAt,
  type InstitutionalCodeType,
} from "./institutionalAccess";

const INSTITUTIONAL_CODE_SALT_ROUNDS = 10;
let institutionalUserColumnsMigrationDone = false;
let institutionalRedemptionConsistencyMigrationDone = false;
let subscriptionResetDone = false;
let userInstitutionalRedemptionsTableDone = false;
let multiSpecialtyMigrationDone = false;
let questionsFlaggedColumnDone = false;
let questionsImageColumnsDone = false;
let testSessionsSpecialtyColumnDone = false;
let feedbackAgentTablesDone = false;
let usersEmailUniquenessDone = false;

function sectionsMatchSpecialty(specialtyId: SpecialtyId) {
  const id = getSpecialty(specialtyId).id;
  if (id === "ortho") {
    return or(eq(sections.specialtyId, "ortho"), like(sections.id, "ortho-%"));
  }
  return and(eq(sections.specialtyId, "prs"), notLike(sections.id, "ortho-%"));
}
function questionIdMatchesSpecialtySql(
  column: typeof questions.id | typeof spacedRepetitions.questionId | typeof bookmarks.questionId | typeof questionResponses.questionId,
  specialtyId: SpecialtyId,
) {
  return specialtyId === "ortho" ? like(column, "ortho-%") : notLike(column, "ortho-%");
}

function testSessionMatchesSpecialty(session: TestSession, specialtyId: SpecialtyId): boolean {
  const stored = (session as TestSession & { specialtyId?: string | null }).specialtyId;
  if (stored === "ortho" || stored === "prs") return stored === specialtyId;
  const selected = Array.isArray(session.selectedSectionIds) ? session.selectedSectionIds : [];
  const questionIds = Array.isArray(session.questions)
    ? (session.questions as { id?: string }[]).map((q) => q?.id).filter((id): id is string => !!id)
    : [];
  const ids = [...selected, ...questionIds];
  if (ids.length === 0) return specialtyId === "prs";
  return ids.some((id) => contentIdMatchesSpecialty(id, specialtyId));
}

/**
 * Entitlement fields that exist on both `user_specialty_subscriptions` and (as the Plastic Surgery
 * mirror) on `users`. Writing through `updateSpecialtyEntitlement` keeps the two in sync.
 */
export type SpecialtyEntitlementUpdate = Partial<{
  subscriptionStatus: string;
  subscriptionPlan: string | null;
  trialEndsAt: Date | null;
  subscriptionEndsAt: Date | null;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionCanceledAt: Date | null;
  stripeSubscriptionId: string | null;
  subscriptionTrialUsed: boolean;
  institutionalAccessAffiliation: string | null;
  institutionalAccessExpiresAt: Date | null;
}>;

export type SectionQuestionDto = {
  id: string;
  question: string;
  answer: string;
  category: string;
  subcategory: string;
  tags: string[];
  imageUrl?: string | null;
  imageAlt?: string | null;
  /** Credit line for open-access images (PMC); null for in-house images. */
  imageAttribution?: {
    credit: string | null;
    license: string | null;
    sourceUrl: string | null;
    pmcid: string | null;
  } | null;
};

export type SectionDto = {
  id: string;
  title: string;
  subsections: { id: string; title: string; questions: SectionQuestionDto[] }[];
};

/** Public marketing outline: titles + counts only (no stems or answers). */
export type SectionMetaDto = {
  id: string;
  title: string;
  subsections: { id: string; title: string; questionCount: number }[];
};

// Interface for storage operations
export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  updateUserProfile(id: string, updates: Partial<UpsertUser>): Promise<User>;
  updateUserPassword(id: string, passwordHash: string, needsReset: boolean): Promise<User>;
  deletePasswordResetTokensForUser(userId: string): Promise<void>;
  createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void>;
  /** Atomically validate, delete token, and return user id if valid and not expired. */
  takePasswordResetToken(tokenHash: string): Promise<string | undefined>;

  // Test Session operations
  createTestSession(session: InsertTestSession): Promise<TestSession>;
  getTestSession(id: string): Promise<TestSession | undefined>;
  getUserTestSessions(userId: string, specialtyId?: SpecialtyId): Promise<TestSession[]>;
  getInProgressSessions(userId: string, specialtyId?: SpecialtyId): Promise<TestSession[]>;
  updateTestSession(id: string, updates: Partial<InsertTestSession>): Promise<TestSession>;
  completeTestSession(id: string): Promise<TestSession>;
  deleteTestSession(id: string): Promise<void>;

  // Question Response operations
  createQuestionResponse(response: InsertQuestionResponse): Promise<QuestionResponse>;
  getTestSessionResponses(testSessionId: string): Promise<QuestionResponse[]>;
  upsertQuestionResponse(response: InsertQuestionResponse): Promise<QuestionResponse>;

  // Login Connection operations
  getLoginConnections(userId: string): Promise<LoginConnection[]>;
  addLoginConnection(userId: string, provider: string): Promise<LoginConnection>;
  removeLoginConnection(userId: string, provider: string): Promise<void>;

  // Notes operations
  createNote(note: InsertNote): Promise<Note>;
  getUserNotes(userId: string, sectionId?: string, subsectionId?: string): Promise<Note[]>;
  updateNote(id: string, updates: Partial<InsertNote>): Promise<Note>;
  deleteNote(id: string): Promise<void>;

  // Highlights operations
  createHighlight(highlight: InsertHighlight): Promise<Highlight>;
  getUserHighlights(userId: string): Promise<Highlight[]>;
  updateHighlight(id: string, updates: Partial<InsertHighlight>): Promise<Highlight>;
  deleteHighlight(id: string): Promise<void>;
  deleteHighlightsByLocation(userId: string, sectionId: string, subsectionId: string, location: string, questionId?: string): Promise<void>;

  // Study-mode question responses (without testSessionId)
  getUserQuestionResponses(userId: string, specialtyId?: SpecialtyId): Promise<QuestionResponse[]>;
  upsertStudyModeResponse(userId: string, response: {
    questionId: string;
    sectionId: string;
    subsectionId: string;
    selectedAnswer: string;
    correctAnswer: string;
    isCorrect: boolean;
  }): Promise<QuestionResponse>;
  deleteAllStudyModeResponses(userId: string): Promise<void>;

  // Bookmarks operations
  addBookmark(bookmark: InsertBookmark): Promise<Bookmark>;
  removeBookmark(userId: string, questionId: string): Promise<void>;
  getUserBookmarks(userId: string, specialtyId?: SpecialtyId): Promise<Bookmark[]>;
  isQuestionBookmarked(userId: string, questionId: string): Promise<boolean>;

  // Spaced Repetition operations
  upsertSpacedRepetition(sr: InsertSpacedRepetition): Promise<SpacedRepetition>;
  getSpacedRepetition(userId: string, questionId: string): Promise<SpacedRepetition | undefined>;
  getUserDueQuestions(userId: string, specialtyId?: SpecialtyId): Promise<SpacedRepetition[]>;
  getUserSpacedRepetitionQuestionIds(userId: string, specialtyId?: SpecialtyId): Promise<string[]>;
  getUserIncorrectQuestionIds(userId: string, specialtyId?: SpecialtyId): Promise<string[]>;
  updateSpacedRepetition(id: string, updates: Partial<InsertSpacedRepetition>): Promise<SpacedRepetition>;

  // Topic Analytics operations
  getTopicStats(userId: string, sectionId?: string): Promise<{
    sectionId: string;
    sectionTitle?: string;
    total: number;
    correct: number;
    accuracy: number;
  }[]>;

  // Specialty (multi q-bank) operations
  /** The q-bank the user currently has selected. */
  getActiveSpecialty(userId: string): Promise<SpecialtyId>;
  setActiveSpecialty(userId: string, specialtyId: SpecialtyId): Promise<SpecialtyId>;
  /** Entitlement row for one q-bank; created lazily as "expired" when missing. */
  getSpecialtyEntitlement(userId: string, specialtyId: SpecialtyId): Promise<UserSpecialtySubscription>;
  listSpecialtyEntitlements(userId: string): Promise<UserSpecialtySubscription[]>;
  updateSpecialtyEntitlement(
    userId: string,
    specialtyId: SpecialtyId,
    updates: SpecialtyEntitlementUpdate,
  ): Promise<UserSpecialtySubscription>;
  /**
   * `User` with its entitlement columns replaced by the given specialty's row, so entitlement
   * logic written against the legacy single-specialty shape stays correct per q-bank.
   */
  getUserWithSpecialtyEntitlement(
    userId: string,
    specialtyId: SpecialtyId,
  ): Promise<User | undefined>;

  // Subscription operations
  warmupSubscriptionSchema(): Promise<void>;
  initializeSubscriptionPlans(specialtyId?: SpecialtyId): Promise<SubscriptionPlan[]>;
  getSubscriptionPlans(specialtyId?: SpecialtyId): Promise<SubscriptionPlan[]>;
  /** Plan lookup by id across every specialty (checkout/webhooks resolve specialty from the plan). */
  getSubscriptionPlanById(planId: string): Promise<SubscriptionPlan | undefined>;
  createSubscriptionTransaction(transaction: InsertSubscriptionTransaction): Promise<SubscriptionTransaction>;
  getUserActiveSubscription(
    userId: string,
    specialtyId?: SpecialtyId,
  ): Promise<SubscriptionTransaction | undefined>;
  cancelUserSubscription(userId: string, specialtyId?: SpecialtyId): Promise<void>;
  getUserSubscriptionTransactions(
    userId: string,
    specialtyId?: SpecialtyId,
  ): Promise<SubscriptionTransaction[]>;
  /** Idempotent Stripe invoice handling (renewals). */
  getSubscriptionTransactionByStripeInvoiceId(invoiceId: string): Promise<SubscriptionTransaction | undefined>;
  /** Entitlement row (user + specialty) that owns a Stripe subscription id. */
  getEntitlementByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<UserSpecialtySubscription | undefined>;
  /** Entitlements currently linked to Stripe subscriptions (for periodic reconciliation). */
  getEntitlementsWithStripeSubscriptions(): Promise<UserSpecialtySubscription[]>;
  /** False if user already consumed the intro trial for this q-bank. */
  getIntroTrialEligibility(userId: string, specialtyId?: SpecialtyId): Promise<boolean>;

  // Institutional codes (hashed in DB; validate returns institution display name)
  ensureInstitutionalCodesSeed(): Promise<void>;
  validateInstitutionalCode(plainCode: string): Promise<string | null>;
  /** Match plaintext to a code row; used for redeem (needs code id + specialty for per-code dedup). */
  resolveInstitutionalCode(plainCode: string): Promise<
    | {
        type: "ok";
        institutionName: string;
        codeId: string;
        specialtyId: SpecialtyId;
        codeType: InstitutionalCodeType;
        maxRedemptions: number | null;
      }
    | { type: "inactive" }
    | { type: "redeem_expired" }
    | { type: "exhausted" }
    | { type: "not_found" }
  >;
  getInstitutionalCodesAdmin(): Promise<
    {
      id: string;
      institutionName: string;
      specialtyId: SpecialtyId;
      codeType: InstitutionalCodeType;
      active: boolean;
      createdAt: Date | null;
      redeemExpiresAt: Date | null;
    }[]
  >;
  createInstitutionalCodeAdmin(
    plainCode: string,
    institutionName: string,
    specialtyId?: SpecialtyId,
    codeType?: InstitutionalCodeType,
  ): Promise<{ id: string; redeemExpiresAt: Date }>;
  setInstitutionalCodeActiveAdmin(id: string, active: boolean): Promise<boolean>;
  hasUserRedeemedInstitutionalCode(userId: string, institutionalCodeId: string): Promise<boolean>;
  /** True if this account has ever redeemed any trial-type code (any q-bank). */
  hasUserRedeemedAnyTrialCode(userId: string): Promise<boolean>;
  recordInstitutionalCodeRedemption(
    userId: string,
    institutionalCodeId: string,
    specialtyId?: SpecialtyId,
    grant?: { institutionName: string; expiresAt: Date },
  ): Promise<{ ok: true } | { ok: false; reason: "exhausted" | "already_redeemed" }>;
  /** True if this account has redeemed at least one institutional code for the q-bank. */
  userHasAnyInstitutionalRedemption(userId: string, specialtyId?: SpecialtyId): Promise<boolean>;
  /** Most recent code redemption for this q-bank, used to distinguish trial vs institutional grants. */
  getLatestInstitutionalCodeGrant(
    userId: string,
    specialtyId?: SpecialtyId,
  ): Promise<{
    codeType: InstitutionalCodeType;
    institutionName: string;
    redeemedAt: Date | null;
  } | null>;
  /**
   * If user has a code redemption row but no expiry (legacy), set duration from the code type
   * (30 days for trial, 365 days for institutional). Idempotent when expiry already set.
   */
  ensureInstitutionalAccessExpiryWhenMissing(
    userId: string,
    userHint?: User | undefined,
    specialtyId?: SpecialtyId,
  ): Promise<void>;
  /** When RUN_SUBSCRIPTION_RESET=true, reset all users to no subscription once. Call at startup. */
  runSubscriptionResetIfRequested(): Promise<void>;

  // Theme preference operations
  getThemePreference(userId: string): Promise<string>;
  updateThemePreference(userId: string, theme: string): Promise<string>;

  // Cross-domain auth handoff (prs-atlas.com ↔ ortho-atlas.com)
  createAuthHandoffToken(params: {
    userId: string;
    targetSpecialtyId: SpecialtyId;
    nextPath?: string;
    continueExternalUrl?: string | null;
  }): Promise<{ plainToken: string; expiresAt: Date }>;
  consumeAuthHandoffToken(plainToken: string): Promise<{
    userId: string;
    targetSpecialtyId: SpecialtyId;
    nextPath: string;
    continueExternalUrl: string | null;
  } | null>;
  setPendingCheckoutPlan(
    userId: string,
    planId: string,
    specialtyId: SpecialtyId,
  ): Promise<void>;
  takePendingCheckoutPlan(userId: string): Promise<{ planId: string; specialtyId: SpecialtyId } | null>;
  clearPendingCheckoutPlan(userId: string): Promise<void>;

  // Percentile rank operations (scoped to one question bank)
  getUserPercentileRank(userId: string, specialtyId?: SpecialtyId): Promise<number | null>;

  // Question bank (sections API)
  getSections(specialtyId?: SpecialtyId): Promise<SectionDto[]>;
  /** Titles + question counts only — safe for unauthenticated marketing pages. */
  getSectionsMeta(specialtyId?: SpecialtyId): Promise<SectionMetaDto[]>;
  /** Deterministic capped preview set (stems + answers for the free sample only). */
  getPreviewQuestions(specialtyId?: SpecialtyId, count?: number): Promise<SectionQuestionDto[]>;

  // Question reports
  getQuestionForReport(id: string): Promise<{
    question: string;
    answer: string;
    subsectionId: string;
    specialtyId: SpecialtyId;
  } | undefined>;
  createQuestionReport(report: InsertQuestionReport): Promise<QuestionReport>;
  getAllQuestionReports(): Promise<QuestionReport[]>;
  countQuestionReportsForQuestion(questionId: string): Promise<number>;
  /** If question exists, set visible=false and reported=true (idempotent). */
  hideQuestionDueToReports(questionId: string): Promise<boolean>;
  /**
   * Content-audit flag (any specialty). Hides the question until unflagged.
   * Sets flagged=true and visible=false.
   */
  flagQuestion(questionId: string, reasonTag?: string): Promise<boolean>;
  /**
   * Clears content-audit flag. Restores visible=true unless the question is reported.
   */
  unflagQuestion(questionId: string): Promise<boolean>;
  createContactMessage(msg: InsertContactMessage): Promise<ContactMessage>;
  getContactMessagesSince(since: Date): Promise<ContactMessage[]>;
  getQuestionReportsSince(since: Date): Promise<QuestionReport[]>;
  getMissRatesSince(since: Date): Promise<
    { questionId: string; subsectionId: string; answered: number; incorrect: number }[]
  >;
  /**
   * Live questions with correct-rate ≥ `minCorrectRate` in the window,
   * at least `minAnswers` responses. Includes unique user count.
   */
  getHighCorrectRateQuestionsSince(
    since: Date,
    minAnswers: number,
    minCorrectRate?: number
  ): Promise<
    {
      questionId: string;
      subsectionId: string;
      answered: number;
      uniqueUsers: number;
      incorrect: number;
    }[]
  >;
  getLatestRevisionTimes(questionIds: string[]): Promise<Map<string, Date>>;
  createQuestionRevision(row: InsertQuestionRevision): Promise<QuestionRevision>;
  startAgentJobRun(jobName: string): Promise<AgentJobRun>;
  finishAgentJobRun(
    id: string,
    status: "success" | "error",
    stats: Record<string, unknown>
  ): Promise<void>;
  getLastSuccessfulAgentJobRun(jobName: string): Promise<AgentJobRun | undefined>;
  listActiveAgentLessons(limit?: number): Promise<AgentLesson[]>;
  insertAgentLessonIfNew(row: InsertAgentLesson): Promise<boolean>;
  createFinetuneExample(row: InsertAgentFinetuneExample): Promise<AgentFinetuneExample>;
  listFinetuneExamples(kind?: string, limit?: number): Promise<AgentFinetuneExample[]>;
  listRecentRevisedQuestions(limit?: number): Promise<{ question: string; answer: string; subsectionId: string }[]>;
  listRecentRevisions(limit?: number): Promise<QuestionRevision[]>;
  ensureFeedbackAgentTables(): Promise<void>;

  // Oral board simulator (persisted sessions + messages)
  createOralBoardSession(userId: string, openaiThreadId: string): Promise<OralBoardSession>;
  listOralBoardSessionsForUser(userId: string): Promise<
    {
      id: string;
      openaiThreadId: string;
      createdAt: Date | null;
      updatedAt: Date | null;
      sessionNumber: number;
      title: string;
      messageCount: number;
    }[]
  >;
  getOralBoardSessionForUser(userId: string, sessionId: string): Promise<OralBoardSession | undefined>;
  addOralBoardMessage(
    sessionId: string,
    userId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<OralBoardMessage>;
  listOralBoardMessagesForUser(userId: string, sessionId: string): Promise<OralBoardMessage[]>;
  deleteOralBoardSessionForUser(userId: string, sessionId: string): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  private chatBubbleThreads = new Map<string, { id: string; messages: unknown[] }>();

  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  // ---------------------------------------------------------------------------
  // Specialty (multi q-bank) operations
  // ---------------------------------------------------------------------------

  async getActiveSpecialty(userId: string): Promise<SpecialtyId> {
    await this.ensureMultiSpecialtyMigration();
    const [row] = await db
      .select({ activeSpecialtyId: users.activeSpecialtyId })
      .from(users)
      .where(eq(users.id, userId));
    return getSpecialty(row?.activeSpecialtyId).id;
  }

  async setActiveSpecialty(userId: string, specialtyId: SpecialtyId): Promise<SpecialtyId> {
    await this.ensureMultiSpecialtyMigration();
    const target = getSpecialty(specialtyId).id;
    await db
      .update(users)
      .set({ activeSpecialtyId: target, updatedAt: new Date() })
      .where(eq(users.id, userId));
    /** Guarantee an entitlement row exists so the paywall has something to read. */
    await this.getSpecialtyEntitlement(userId, target);
    return target;
  }

  async getSpecialtyEntitlement(
    userId: string,
    specialtyId: SpecialtyId,
  ): Promise<UserSpecialtySubscription> {
    await this.ensureMultiSpecialtyMigration();
    const target = getSpecialty(specialtyId).id;
    const [existing] = await db
      .select()
      .from(userSpecialtySubscriptions)
      .where(
        and(
          eq(userSpecialtySubscriptions.userId, userId),
          eq(userSpecialtySubscriptions.specialtyId, target),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await db
      .insert(userSpecialtySubscriptions)
      .values({ userId, specialtyId: target, subscriptionStatus: "expired" })
      .onConflictDoNothing({
        target: [userSpecialtySubscriptions.userId, userSpecialtySubscriptions.specialtyId],
      })
      .returning();
    if (created) return created;

    const [afterRace] = await db
      .select()
      .from(userSpecialtySubscriptions)
      .where(
        and(
          eq(userSpecialtySubscriptions.userId, userId),
          eq(userSpecialtySubscriptions.specialtyId, target),
        ),
      )
      .limit(1);
    if (!afterRace) throw new Error(`Failed to create entitlement row for ${userId}/${target}`);
    return afterRace;
  }

  async listSpecialtyEntitlements(userId: string): Promise<UserSpecialtySubscription[]> {
    await this.ensureMultiSpecialtyMigration();
    for (const id of SPECIALTY_IDS) {
      await this.getSpecialtyEntitlement(userId, id);
    }
    return db
      .select()
      .from(userSpecialtySubscriptions)
      .where(eq(userSpecialtySubscriptions.userId, userId));
  }

  async updateSpecialtyEntitlement(
    userId: string,
    specialtyId: SpecialtyId,
    updates: SpecialtyEntitlementUpdate,
  ): Promise<UserSpecialtySubscription> {
    const target = getSpecialty(specialtyId).id;
    await this.getSpecialtyEntitlement(userId, target);

    const [updated] = await db
      .update(userSpecialtySubscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(
        and(
          eq(userSpecialtySubscriptions.userId, userId),
          eq(userSpecialtySubscriptions.specialtyId, target),
        ),
      )
      .returning();

    /** Keep the legacy `users` columns as the Plastic Surgery mirror for untouched code paths. */
    if (target === DEFAULT_SPECIALTY_ID) {
      await db
        .update(users)
        .set({ ...updates, updatedAt: new Date() } as Partial<UpsertUser>)
        .where(eq(users.id, userId));
    }

    if (!updated) throw new Error(`Failed to update entitlement for ${userId}/${target}`);
    return updated;
  }

  async getUserWithSpecialtyEntitlement(
    userId: string,
    specialtyId: SpecialtyId,
  ): Promise<User | undefined> {
    const user = await this.getUser(userId);
    if (!user) return undefined;
    const entitlement = await this.getSpecialtyEntitlement(userId, specialtyId);
    return {
      ...user,
      subscriptionStatus: entitlement.subscriptionStatus,
      subscriptionPlan: entitlement.subscriptionPlan,
      trialEndsAt: entitlement.trialEndsAt,
      subscriptionEndsAt: entitlement.subscriptionEndsAt,
      subscriptionCancelAtPeriodEnd: entitlement.subscriptionCancelAtPeriodEnd,
      subscriptionCanceledAt: entitlement.subscriptionCanceledAt,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      subscriptionTrialUsed: entitlement.subscriptionTrialUsed,
      institutionalAccessAffiliation: entitlement.institutionalAccessAffiliation,
      institutionalAccessExpiresAt: entitlement.institutionalAccessExpiresAt,
    };
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    await this.ensureUsersEmailUniqueness();
    const normalized = email.trim().toLowerCase();
    if (!normalized) return undefined;
    const matches = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalized}`);
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];
    return matches.find((u) => Boolean(u.passwordHash)) ?? matches[0];
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    await this.ensureUsersEmailUniqueness();
    const values = userData.email
      ? { ...userData, email: userData.email.trim().toLowerCase() }
      : userData;
    const [user] = await db
      .insert(users)
      .values(values)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...values,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  async updateUserProfile(userId: string, updates: Partial<UpsertUser>): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserPassword(userId: string, passwordHash: string, needsReset: boolean): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        passwordHash,
        passwordNeedsReset: needsReset,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async deletePasswordResetTokensForUser(userId: string): Promise<void> {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  }

  async createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await db.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      expiresAt,
    });
  }

  async takePasswordResetToken(tokenHash: string): Promise<string | undefined> {
    // Single statement: two concurrent redemptions of one link cannot both see the row.
    const [row] = await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .returning({
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
      });
    if (!row) {
      return undefined;
    }
    if (row.expiresAt < new Date()) {
      return undefined;
    }
    return row.userId;
  }

  async updateUserTester(userId: string, tester: boolean): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ tester, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  // Test Session operations
  async createTestSession(sessionData: InsertTestSession): Promise<TestSession> {
    await this.ensureTestSessionsSpecialtyColumn();
    const [session] = await db
      .insert(testSessions)
      .values({
        ...sessionData,
        questions: sessionData.questions || [],
      })
      .returning();
    return session;
  }

  async getTestSession(id: string): Promise<TestSession | undefined> {
    const [session] = await db
      .select()
      .from(testSessions)
      .where(eq(testSessions.id, id));
    return session;
  }

  async getUserTestSessions(userId: string, specialtyId?: SpecialtyId): Promise<TestSession[]> {
    await this.ensureTestSessionsSpecialtyColumn();
    const rows = await db
      .select()
      .from(testSessions)
      .where(eq(testSessions.userId, userId))
      .orderBy(desc(testSessions.createdAt));
    return specialtyId ? rows.filter((row) => testSessionMatchesSpecialty(row, specialtyId)) : rows;
  }

  async getInProgressSessions(userId: string, specialtyId?: SpecialtyId): Promise<TestSession[]> {
    await this.ensureTestSessionsSpecialtyColumn();
    const rows = await db
      .select()
      .from(testSessions)
      .where(
        and(
          eq(testSessions.userId, userId),
          eq(testSessions.status, 'in-progress')
        )
      )
      .orderBy(desc(testSessions.createdAt));
    return specialtyId ? rows.filter((row) => testSessionMatchesSpecialty(row, specialtyId)) : rows;
  }

  async updateTestSession(id: string, updates: Partial<InsertTestSession>): Promise<TestSession> {
    const [session] = await db
      .update(testSessions)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(testSessions.id, id))
      .returning();
    return session;
  }

  async completeTestSession(id: string): Promise<TestSession> {
    const [session] = await db
      .update(testSessions)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(testSessions.id, id))
      .returning();
    return session;
  }

  async deleteTestSession(id: string): Promise<void> {
    await db
      .delete(testSessions)
      .where(eq(testSessions.id, id));
  }

  // Question Response operations
  async createQuestionResponse(responseData: InsertQuestionResponse): Promise<QuestionResponse> {
    const [response] = await db
      .insert(questionResponses)
      .values(responseData)
      .returning();
    return response;
  }

  async getTestSessionResponses(testSessionId: string): Promise<QuestionResponse[]> {
    return await db
      .select()
      .from(questionResponses)
      .where(eq(questionResponses.testSessionId, testSessionId));
  }

  async upsertQuestionResponse(responseData: InsertQuestionResponse): Promise<QuestionResponse> {
    // Try to find existing response first
    const [existing] = await db
      .select()
      .from(questionResponses)
      .where(
        and(
          eq(questionResponses.testSessionId, responseData.testSessionId as any),
          eq(questionResponses.questionId, responseData.questionId)
        )
      );

    if (existing) {
      // Update existing
      const [updated] = await db
        .update(questionResponses)
        .set({
          selectedAnswer: responseData.selectedAnswer,
          isCorrect: responseData.isCorrect,
          answeredAt: new Date(),
        })
        .where(eq(questionResponses.id, existing.id))
        .returning();
      return updated;
    } else {
      // Create new
      return await this.createQuestionResponse(responseData);
    }
  }

  // Login Connection operations
  async getLoginConnections(userId: string): Promise<LoginConnection[]> {
    return await db
      .select()
      .from(loginConnections)
      .where(eq(loginConnections.userId, userId));
  }

  async addLoginConnection(userId: string, provider: string): Promise<LoginConnection> {
    const [conn] = await db
      .insert(loginConnections)
      .values({ userId, provider })
      .onConflictDoNothing()
      .returning();
    return conn || (await db.select().from(loginConnections).where(and(eq(loginConnections.userId, userId), eq(loginConnections.provider, provider))).then(r => r[0]));
  }

  async removeLoginConnection(userId: string, provider: string): Promise<void> {
    await db
      .delete(loginConnections)
      .where(and(eq(loginConnections.userId, userId), eq(loginConnections.provider, provider)));
  }

  // Notes operations
  async createNote(noteData: InsertNote): Promise<Note> {
    const [note] = await db
      .insert(notes)
      .values(noteData)
      .returning();
    return note;
  }

  async getUserNotes(userId: string, sectionId?: string, subsectionId?: string): Promise<Note[]> {
    const conditions: any[] = [eq(notes.userId, userId)];
    
    if (sectionId && subsectionId) {
      conditions.push(eq(notes.sectionId, sectionId));
      conditions.push(eq(notes.subsectionId, subsectionId));
    }
    
    return await db
      .select()
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.createdAt));
  }

  async updateNote(id: string, updates: Partial<InsertNote>): Promise<Note> {
    const [note] = await db
      .update(notes)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .returning();
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    await db.delete(notes).where(eq(notes.id, id));
  }

  // Highlights operations
  async createHighlight(highlightData: InsertHighlight): Promise<Highlight> {
    const [highlight] = await db
      .insert(highlights)
      .values(highlightData)
      .returning();
    return highlight;
  }

  async getUserHighlights(userId: string): Promise<Highlight[]> {
    return await db
      .select()
      .from(highlights)
      .where(eq(highlights.userId, userId))
      .orderBy(desc(highlights.createdAt));
  }

  async updateHighlight(id: string, updates: Partial<InsertHighlight>): Promise<Highlight> {
    const [highlight] = await db
      .update(highlights)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(highlights.id, id))
      .returning();
    return highlight;
  }

  async deleteHighlight(id: string): Promise<void> {
    await db.delete(highlights).where(eq(highlights.id, id));
  }

  async deleteHighlightsByLocation(
    userId: string,
    sectionId: string,
    subsectionId: string,
    location: string,
    questionId?: string
  ): Promise<void> {
    const conditions = [
      eq(highlights.userId, userId),
      eq(highlights.sectionId, sectionId),
      eq(highlights.subsectionId, subsectionId),
      eq(highlights.location, location),
    ];
    
    if (questionId) {
      conditions.push(eq(highlights.questionId, questionId));
    }
    
    await db.delete(highlights).where(and(...conditions));
  }

  // Study-mode question responses (without testSessionId)
  async getUserQuestionResponses(userId: string, specialtyId?: SpecialtyId): Promise<QuestionResponse[]> {
    return await db
      .select()
      .from(questionResponses)
      .where(
        specialtyId
          ? and(eq(questionResponses.userId, userId), questionIdMatchesSpecialtySql(questionResponses.questionId, specialtyId))
          : eq(questionResponses.userId, userId)
      )
      .orderBy(desc(questionResponses.answeredAt));
  }

  async upsertStudyModeResponse(userId: string, response: {
    questionId: string;
    sectionId: string;
    subsectionId: string;
    selectedAnswer: string;
    correctAnswer: string;
    isCorrect: boolean;
  }): Promise<QuestionResponse> {
    // Check if a response already exists for this user+question (study mode - no testSessionId)
    const [existing] = await db
      .select()
      .from(questionResponses)
      .where(
        and(
          eq(questionResponses.userId, userId),
          eq(questionResponses.questionId, response.questionId),
          // Study mode responses have no testSessionId
        )
      );

    if (existing) {
      // Update existing response
      const [updated] = await db
        .update(questionResponses)
        .set({
          selectedAnswer: response.selectedAnswer,
          correctAnswer: response.correctAnswer,
          isCorrect: response.isCorrect,
          answeredAt: new Date(),
        })
        .where(eq(questionResponses.id, existing.id))
        .returning();
      return updated;
    } else {
      // Create new response
      const [created] = await db
        .insert(questionResponses)
        .values({
          userId,
          testSessionId: null, // Study mode - no test session
          questionId: response.questionId,
          sectionId: response.sectionId,
          subsectionId: response.subsectionId,
          selectedAnswer: response.selectedAnswer,
          correctAnswer: response.correctAnswer,
          isCorrect: response.isCorrect,
        })
        .returning();
      return created;
    }
  }

  async deleteAllStudyModeResponses(userId: string): Promise<void> {
    await db
      .delete(questionResponses)
      .where(eq(questionResponses.userId, userId));
  }

  // Bookmarks operations
  async addBookmark(bookmarkData: InsertBookmark): Promise<Bookmark> {
    const [bookmark] = await db
      .insert(bookmarks)
      .values(bookmarkData)
      .onConflictDoNothing()
      .returning();
    
    if (bookmark) return bookmark;
    
    // If it was a conflict (already exists), return the existing bookmark
    const [existing] = await db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, bookmarkData.userId),
          eq(bookmarks.questionId, bookmarkData.questionId)
        )
      );
    return existing;
  }

  async removeBookmark(userId: string, questionId: string): Promise<void> {
    await db
      .delete(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, userId),
          eq(bookmarks.questionId, questionId)
        )
      );
  }

  async getUserBookmarks(userId: string, specialtyId?: SpecialtyId): Promise<Bookmark[]> {
    return await db
      .select()
      .from(bookmarks)
      .where(
        specialtyId
          ? and(eq(bookmarks.userId, userId), questionIdMatchesSpecialtySql(bookmarks.questionId, specialtyId))
          : eq(bookmarks.userId, userId)
      )
      .orderBy(desc(bookmarks.createdAt));
  }

  async isQuestionBookmarked(userId: string, questionId: string): Promise<boolean> {
    const [result] = await db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, userId),
          eq(bookmarks.questionId, questionId)
        )
      );
    return !!result;
  }

  // Spaced Repetition operations
  async upsertSpacedRepetition(srData: InsertSpacedRepetition): Promise<SpacedRepetition> {
    const [existing] = await db
      .select()
      .from(spacedRepetitions)
      .where(
        and(
          eq(spacedRepetitions.userId, srData.userId),
          eq(spacedRepetitions.questionId, srData.questionId)
        )
      );

    if (existing) {
      const [updated] = await db
        .update(spacedRepetitions)
        .set({
          ...srData,
          updatedAt: new Date(),
        })
        .where(eq(spacedRepetitions.id, existing.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(spacedRepetitions)
        .values(srData)
        .returning();
      return created;
    }
  }

  async getSpacedRepetition(userId: string, questionId: string): Promise<SpacedRepetition | undefined> {
    const [result] = await db
      .select()
      .from(spacedRepetitions)
      .where(
        and(
          eq(spacedRepetitions.userId, userId),
          eq(spacedRepetitions.questionId, questionId)
        )
      );
    return result;
  }

  async getUserDueQuestions(userId: string, specialtyId?: SpecialtyId): Promise<SpacedRepetition[]> {
    const now = new Date();
    return await db
      .select()
      .from(spacedRepetitions)
      .where(
        and(
          eq(spacedRepetitions.userId, userId),
          lte(spacedRepetitions.nextReviewAt, now),
          ...(specialtyId ? [questionIdMatchesSpecialtySql(spacedRepetitions.questionId, specialtyId)] : []),
        )
      )
      .orderBy(spacedRepetitions.nextReviewAt);
  }

  async getUserSpacedRepetitionQuestionIds(userId: string, specialtyId?: SpecialtyId): Promise<string[]> {
    const rows = await db
      .select({ questionId: spacedRepetitions.questionId })
      .from(spacedRepetitions)
      .where(
        specialtyId
          ? and(eq(spacedRepetitions.userId, userId), questionIdMatchesSpecialtySql(spacedRepetitions.questionId, specialtyId))
          : eq(spacedRepetitions.userId, userId)
      );
    return rows.map((r) => r.questionId);
  }

  async getUserIncorrectQuestionIds(userId: string, specialtyId?: SpecialtyId): Promise<string[]> {
    const rows = await db
      .selectDistinct({ questionId: questionResponses.questionId })
      .from(questionResponses)
      .where(
        and(
          eq(questionResponses.userId, userId),
          eq(questionResponses.isCorrect, false),
          ...(specialtyId ? [questionIdMatchesSpecialtySql(questionResponses.questionId, specialtyId)] : []),
        )
      );
    return rows.map((r) => r.questionId);
  }

  async updateSpacedRepetition(id: string, updates: Partial<InsertSpacedRepetition>): Promise<SpacedRepetition> {
    const [updated] = await db
      .update(spacedRepetitions)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(spacedRepetitions.id, id))
      .returning();
    return updated;
  }

  async getSections(specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID): Promise<SectionDto[]> {
    await this.ensureMultiSpecialtyMigration();
    await this.ensureQuestionsFlaggedColumn();
    await this.ensureQuestionsImageColumns();
    const sectionRows = await db
      .select()
      .from(sections)
      .where(sectionsMatchSpecialty(specialtyId))
      .orderBy(asc(sections.sortOrder));
    if (sectionRows.length === 0) return [];
    const subsectionRows = await db.select().from(subsections).orderBy(asc(subsections.sortOrder));
    const questionRows = await db.select().from(questions);
    const bySub = new Map<string, typeof questionRows>();
    for (const q of questionRows) {
      // Only include visible, unflagged questions (applies to every specialty bank)
      if (q.visible === false) continue;
      if (q.flagged === true) continue;
      if (!q.imageUrl && extractQuestionStem(q.question).toLowerCase().includes("radiographic")) continue;
      if (!q.imageUrl && questionMcqChoicesReferenceSeeImage(q.question)) continue;
      const list = bySub.get(q.subsectionId) ?? [];
      list.push(q);
      bySub.set(q.subsectionId, list);
    }
    const bySec = new Map<string, typeof subsectionRows>();
    for (const s of subsectionRows) {
      const list = bySec.get(s.sectionId) ?? [];
      list.push(s);
      bySec.set(s.sectionId, list);
    }
    return sectionRows.map((sec) => {
      const subs = (bySec.get(sec.id) ?? []).map((sub) => ({
        id: sub.id,
        title: subsectionTitles[sub.id] ?? orthoSubsectionTitles[sub.id] ?? sub.title,
        questions: (bySub.get(sub.id) ?? []).map((q) => ({
          id: q.id,
          question: q.question,
          answer: q.answer,
          category: sec.id,
          subcategory: sub.id,
          tags: q.tags ?? [],
          imageUrl: q.imageUrl ?? null,
          imageAlt: q.imageAlt ?? null,
          imageAttribution:
            q.imageUrl && (q.imageCredit || q.imageLicense || q.imageSourceUrl || q.imageSourcePmcid)
              ? {
                  credit: q.imageCredit ?? null,
                  license: q.imageLicense ?? null,
                  sourceUrl: q.imageSourceUrl ?? null,
                  pmcid: q.imageSourcePmcid ?? null,
                }
              : null,
        })),
      }));
      return { id: sec.id, title: sec.title, subsections: subs };
    });
  }

  async getSectionsMeta(specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID): Promise<SectionMetaDto[]> {
    const sections = await this.getSections(specialtyId);
    return sections
      .map((sec) => ({
        id: sec.id,
        title: sec.title,
        subsections: sec.subsections
          .map((sub) => ({
            id: sub.id,
            title: sub.title,
            questionCount: sub.questions.length,
          }))
          .filter((sub) => sub.questionCount > 0),
      }))
      .filter((sec) => sec.subsections.length > 0);
  }

  async getPreviewQuestions(
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
    count: number = PREVIEW_COUNT,
  ): Promise<SectionQuestionDto[]> {
    const sections = await this.getSections(specialtyId);
    const all = sections.flatMap((sec) => sec.subsections.flatMap((sub) => sub.questions));
    return selectPreviewQuestions(all, count);
  }

  async createQuestionReport(report: InsertQuestionReport): Promise<QuestionReport> {
    const [row] = await db.insert(questionReports).values(report).returning();
    if (!row) throw new Error("Failed to insert question report");
    return row;
  }

  async getAllQuestionReports(): Promise<QuestionReport[]> {
    return db.select().from(questionReports).orderBy(desc(questionReports.createdAt));
  }

  async countQuestionReportsForQuestion(questionId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(questionReports)
      .where(eq(questionReports.questionId, questionId));
    return Number(row?.n ?? 0);
  }

  async hideQuestionDueToReports(questionId: string): Promise<boolean> {
    const [updated] = await db
      .update(questions)
      .set({ visible: false, reported: true, updatedAt: new Date() })
      .where(eq(questions.id, questionId))
      .returning({ id: questions.id });
    return !!updated;
  }

  async flagQuestion(questionId: string, reasonTag?: string): Promise<boolean> {
    await this.ensureQuestionsFlaggedColumn();
    const [row] = await db.select().from(questions).where(eq(questions.id, questionId));
    if (!row) return false;
    const tags = Array.isArray(row.tags) ? [...row.tags] : [];
    if (!tags.includes("content-flagged")) tags.push("content-flagged");
    if (reasonTag && !tags.includes(reasonTag)) tags.push(reasonTag);
    const [updated] = await db
      .update(questions)
      .set({ flagged: true, visible: false, tags, updatedAt: new Date() })
      .where(eq(questions.id, questionId))
      .returning({ id: questions.id });
    return !!updated;
  }

  async unflagQuestion(questionId: string): Promise<boolean> {
    await this.ensureQuestionsFlaggedColumn();
    const [row] = await db.select().from(questions).where(eq(questions.id, questionId));
    if (!row) return false;
    const tags = (Array.isArray(row.tags) ? row.tags : []).filter(
      (t) =>
        t !== "content-flagged" &&
        t !== "validation-flagged" &&
        t !== "needs-manual-revision"
    );
    // Restore visibility unless report-volume hide still applies
    const visible = row.reported ? false : true;
    const [updated] = await db
      .update(questions)
      .set({ flagged: false, visible, tags, updatedAt: new Date() })
      .where(eq(questions.id, questionId))
      .returning({ id: questions.id });
    return !!updated;
  }

  async createContactMessage(msg: InsertContactMessage): Promise<ContactMessage> {
    await this.ensureFeedbackAgentTables();
    const [row] = await db.insert(contactMessages).values(msg).returning();
    if (!row) throw new Error("Failed to store contact message");
    return row;
  }

  async getContactMessagesSince(since: Date): Promise<ContactMessage[]> {
    await this.ensureFeedbackAgentTables();
    return db
      .select()
      .from(contactMessages)
      .where(gte(contactMessages.createdAt, since))
      .orderBy(desc(contactMessages.createdAt));
  }

  async getQuestionReportsSince(since: Date): Promise<QuestionReport[]> {
    return db
      .select()
      .from(questionReports)
      .where(gte(questionReports.createdAt, since))
      .orderBy(desc(questionReports.createdAt));
  }

  async getMissRatesSince(since: Date): Promise<
    { questionId: string; subsectionId: string; answered: number; incorrect: number }[]
  > {
    const rows = await db
      .select({
        questionId: questionResponses.questionId,
        subsectionId: questionResponses.subsectionId,
        answered: count(),
        incorrect: sql<number>`sum(case when ${questionResponses.isCorrect} then 0 else 1 end)::int`,
      })
      .from(questionResponses)
      .where(gte(questionResponses.answeredAt, since))
      .groupBy(questionResponses.questionId, questionResponses.subsectionId);
    return rows.map((r) => ({
      questionId: r.questionId,
      subsectionId: r.subsectionId,
      answered: Number(r.answered),
      incorrect: Number(r.incorrect ?? 0),
    }));
  }

  async getHighCorrectRateQuestionsSince(
    since: Date,
    minAnswers: number,
    minCorrectRate = 0.9
  ): Promise<
    {
      questionId: string;
      subsectionId: string;
      answered: number;
      uniqueUsers: number;
      incorrect: number;
    }[]
  > {
    await this.ensureQuestionsFlaggedColumn();
    const min = Math.max(1, Math.floor(minAnswers));
    const rate = Math.min(1, Math.max(0, minCorrectRate));
    const rows = await db
      .select({
        questionId: questionResponses.questionId,
        subsectionId: questionResponses.subsectionId,
        answered: count(),
        uniqueUsers: sql<number>`count(distinct ${questionResponses.userId})::int`,
        incorrect: sql<number>`sum(case when ${questionResponses.isCorrect} then 0 else 1 end)::int`,
      })
      .from(questionResponses)
      .innerJoin(questions, eq(questions.id, questionResponses.questionId))
      .where(
        and(
          gte(questionResponses.answeredAt, since),
          eq(questions.visible, true),
          eq(questions.flagged, false)
        )
      )
      .groupBy(questionResponses.questionId, questionResponses.subsectionId)
      .having(
        and(
          sql`count(*) >= ${min}`,
          sql`(count(*) - sum(case when ${questionResponses.isCorrect} then 0 else 1 end))::float / nullif(count(*), 0) >= ${rate}`
        )
      );
    return rows.map((r) => ({
      questionId: r.questionId,
      subsectionId: r.subsectionId,
      answered: Number(r.answered),
      uniqueUsers: Number(r.uniqueUsers ?? 0),
      incorrect: Number(r.incorrect ?? 0),
    }));
  }

  async getLatestRevisionTimes(questionIds: string[]): Promise<Map<string, Date>> {
    await this.ensureFeedbackAgentTables();
    const out = new Map<string, Date>();
    if (questionIds.length === 0) return out;
    const rows = await db
      .select({
        questionId: questionRevisions.questionId,
        createdAt: questionRevisions.createdAt,
      })
      .from(questionRevisions)
      .where(inArray(questionRevisions.questionId, questionIds));
    for (const r of rows) {
      const prev = out.get(r.questionId);
      if (!prev || r.createdAt > prev) out.set(r.questionId, r.createdAt);
    }
    return out;
  }

  async createQuestionRevision(row: InsertQuestionRevision): Promise<QuestionRevision> {
    await this.ensureFeedbackAgentTables();
    const [created] = await db.insert(questionRevisions).values(row).returning();
    if (!created) throw new Error("Failed to store question revision");
    return created;
  }

  async startAgentJobRun(jobName: string): Promise<AgentJobRun> {
    await this.ensureFeedbackAgentTables();
    const [row] = await db
      .insert(agentJobRuns)
      .values({ jobName, status: "running", stats: {} })
      .returning();
    if (!row) throw new Error("Failed to start agent job run");
    return row;
  }

  async finishAgentJobRun(
    id: string,
    status: "success" | "error",
    stats: Record<string, unknown>
  ): Promise<void> {
    await this.ensureFeedbackAgentTables();
    await db
      .update(agentJobRuns)
      .set({ status, stats, finishedAt: new Date() })
      .where(eq(agentJobRuns.id, id));
  }

  async getLastSuccessfulAgentJobRun(jobName: string): Promise<AgentJobRun | undefined> {
    await this.ensureFeedbackAgentTables();
    const [row] = await db
      .select()
      .from(agentJobRuns)
      .where(and(eq(agentJobRuns.jobName, jobName), eq(agentJobRuns.status, "success")))
      .orderBy(desc(agentJobRuns.finishedAt))
      .limit(1);
    return row;
  }

  async ensureFeedbackAgentTables(): Promise<void> {
    if (feedbackAgentTablesDone) return;
    feedbackAgentTablesDone = true;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "contact_messages" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" varchar(200) NOT NULL,
        "email" varchar(320) NOT NULL,
        "subject" varchar(200) NOT NULL,
        "message" text NOT NULL,
        "specialty_id" varchar(32) NOT NULL DEFAULT 'prs',
        "created_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_contact_messages_created_at" ON "contact_messages" ("created_at")`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "question_revisions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "question_id" varchar(128) NOT NULL,
        "action" varchar(32) NOT NULL,
        "previous_question" text,
        "previous_answer" text,
        "new_question" text,
        "new_answer" text,
        "source" varchar(64) NOT NULL DEFAULT 'feedback_agent',
        "rationale" text,
        "report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "run_id" varchar,
        "created_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_revisions_question_id" ON "question_revisions" ("question_id")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_revisions_created_at" ON "question_revisions" ("created_at")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_revisions_run_id" ON "question_revisions" ("run_id")`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "agent_job_runs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "job_name" varchar(64) NOT NULL,
        "started_at" timestamp DEFAULT now() NOT NULL,
        "finished_at" timestamp,
        "status" varchar(20) NOT NULL DEFAULT 'running',
        "stats" jsonb DEFAULT '{}'::jsonb NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_job_runs_job_name" ON "agent_job_runs" ("job_name")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_job_runs_started_at" ON "agent_job_runs" ("started_at")`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "agent_lessons" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "category" varchar(64) NOT NULL,
        "lesson" text NOT NULL,
        "fingerprint" varchar(64) NOT NULL,
        "source" varchar(64) NOT NULL DEFAULT 'feedback_agent',
        "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "active" boolean DEFAULT true NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_lessons_fingerprint" ON "agent_lessons" ("fingerprint")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_lessons_active" ON "agent_lessons" ("active")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_lessons_created_at" ON "agent_lessons" ("created_at")`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "agent_finetune_examples" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "kind" varchar(32) NOT NULL,
        "messages" jsonb NOT NULL,
        "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_finetune_examples_kind" ON "agent_finetune_examples" ("kind")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_finetune_examples_created_at" ON "agent_finetune_examples" ("created_at")`
    );
  }

  async listActiveAgentLessons(limit = 40): Promise<AgentLesson[]> {
    await this.ensureFeedbackAgentTables();
    return db
      .select()
      .from(agentLessons)
      .where(eq(agentLessons.active, true))
      .orderBy(desc(agentLessons.createdAt))
      .limit(limit);
  }

  async insertAgentLessonIfNew(row: InsertAgentLesson): Promise<boolean> {
    await this.ensureFeedbackAgentTables();
    const inserted = await db
      .insert(agentLessons)
      .values(row)
      .onConflictDoNothing({ target: agentLessons.fingerprint })
      .returning({ id: agentLessons.id });
    return inserted.length > 0;
  }

  async createFinetuneExample(row: InsertAgentFinetuneExample): Promise<AgentFinetuneExample> {
    await this.ensureFeedbackAgentTables();
    const [created] = await db.insert(agentFinetuneExamples).values(row).returning();
    if (!created) throw new Error("Failed to store fine-tune example");
    return created;
  }

  async listFinetuneExamples(kind?: string, limit = 5000): Promise<AgentFinetuneExample[]> {
    await this.ensureFeedbackAgentTables();
    if (kind) {
      return db
        .select()
        .from(agentFinetuneExamples)
        .where(eq(agentFinetuneExamples.kind, kind))
        .orderBy(desc(agentFinetuneExamples.createdAt))
        .limit(limit);
    }
    return db
      .select()
      .from(agentFinetuneExamples)
      .orderBy(desc(agentFinetuneExamples.createdAt))
      .limit(limit);
  }

  async listRecentRevisedQuestions(
    limit = 40
  ): Promise<{ question: string; answer: string; subsectionId: string }[]> {
    await this.ensureFeedbackAgentTables();
    const revs = await db
      .select({ questionId: questionRevisions.questionId })
      .from(questionRevisions)
      .where(eq(questionRevisions.action, "revise"))
      .orderBy(desc(questionRevisions.createdAt))
      .limit(limit * 2);
    const ids = [...new Set(revs.map((r) => r.questionId))].slice(0, limit);
    if (ids.length === 0) return [];
    const rows = await db
      .select({
        id: questions.id,
        question: questions.question,
        answer: questions.answer,
        subsectionId: questions.subsectionId,
      })
      .from(questions)
      .where(inArray(questions.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ question: r.question, answer: r.answer, subsectionId: r.subsectionId }));
  }

  async listRecentRevisions(limit = 50): Promise<QuestionRevision[]> {
    await this.ensureFeedbackAgentTables();
    return db
      .select()
      .from(questionRevisions)
      .orderBy(desc(questionRevisions.createdAt))
      .limit(limit);
  }

  async createOralBoardSession(userId: string, openaiThreadId: string): Promise<OralBoardSession> {
    const [row] = await db
      .insert(oralBoardSessions)
      .values({ userId, openaiThreadId })
      .returning();
    if (!row) throw new Error("Failed to create oral board session");
    return row;
  }

  async listOralBoardSessionsForUser(userId: string) {
    const sessionsByCreated = await db
      .select()
      .from(oralBoardSessions)
      .where(eq(oralBoardSessions.userId, userId))
      .orderBy(asc(oralBoardSessions.createdAt));
    if (sessionsByCreated.length === 0) return [];

    const numberById = new Map(sessionsByCreated.map((s, i) => [s.id, i + 1]));
    const ids = sessionsByCreated.map((s) => s.id);

    const countsRows = await db
      .select({ sessionId: oralBoardMessages.sessionId, n: count() })
      .from(oralBoardMessages)
      .where(inArray(oralBoardMessages.sessionId, ids))
      .groupBy(oralBoardMessages.sessionId);
    const countMap = new Map(countsRows.map((r) => [r.sessionId, Number(r.n)]));

    const recent = await db
      .select()
      .from(oralBoardSessions)
      .where(eq(oralBoardSessions.userId, userId))
      .orderBy(desc(oralBoardSessions.updatedAt));

    return recent.map((s) => ({
      id: s.id,
      openaiThreadId: s.openaiThreadId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      sessionNumber: numberById.get(s.id)!,
      title: `Session ${numberById.get(s.id)}`,
      messageCount: countMap.get(s.id) ?? 0,
    }));
  }

  async getOralBoardSessionForUser(userId: string, sessionId: string) {
    const [row] = await db
      .select()
      .from(oralBoardSessions)
      .where(and(eq(oralBoardSessions.id, sessionId), eq(oralBoardSessions.userId, userId)));
    return row;
  }

  async addOralBoardMessage(
    sessionId: string,
    userId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<OralBoardMessage> {
    const session = await this.getOralBoardSessionForUser(userId, sessionId);
    if (!session) throw new Error("Oral board session not found");

    const [msg] = await db
      .insert(oralBoardMessages)
      .values({ sessionId, role, content })
      .returning();
    if (!msg) throw new Error("Failed to save oral board message");

    await db
      .update(oralBoardSessions)
      .set({ updatedAt: new Date() })
      .where(eq(oralBoardSessions.id, sessionId));

    return msg;
  }

  async listOralBoardMessagesForUser(userId: string, sessionId: string): Promise<OralBoardMessage[]> {
    const session = await this.getOralBoardSessionForUser(userId, sessionId);
    if (!session) return [];

    return db
      .select()
      .from(oralBoardMessages)
      .where(eq(oralBoardMessages.sessionId, sessionId))
      .orderBy(asc(oralBoardMessages.createdAt));
  }

  async deleteOralBoardSessionForUser(userId: string, sessionId: string): Promise<boolean> {
    const deleted = await db
      .delete(oralBoardSessions)
      .where(and(eq(oralBoardSessions.id, sessionId), eq(oralBoardSessions.userId, userId)))
      .returning({ id: oralBoardSessions.id });
    return deleted.length > 0;
  }

  async createQuestion(data: {
    question: string;
    answer: string;
    subsectionId: string;
    tags?: string[];
    source?: string;
    visible?: boolean;
  }) {
    const id = crypto.randomUUID();
    const source = (data.source as "imported" | "generated") ?? "imported";
    const visible =
      data.visible !== undefined ? data.visible : source === "generated" ? false : true;
    await db.insert(questions).values({
      id,
      subsectionId: data.subsectionId,
      question: data.question,
      answer: data.answer,
      tags: data.tags ?? [],
      source,
      visible,
    });
    return { id };
  }

  async updateQuestionVisibility(id: string, visible: boolean): Promise<boolean> {
    await this.ensureQuestionsFlaggedColumn();
    if (visible) {
      const [row] = await db.select().from(questions).where(eq(questions.id, id));
      if (row?.flagged) {
        // Cannot show a flagged question; caller must unflag first.
        return false;
      }
    }
    const [updated] = await db
      .update(questions)
      .set({ visible, updatedAt: new Date() })
      .where(eq(questions.id, id))
      .returning({ id: questions.id });
    return !!updated;
  }

  async updateQuestionText(id: string, question: string, answer: string): Promise<boolean> {
    const [updated] = await db
      .update(questions)
      .set({ question, answer, updatedAt: new Date() })
      .where(eq(questions.id, id))
      .returning({ id: questions.id });
    return !!updated;
  }

  /**
   * Set or clear a question image. Attribution columns follow the image: pass `attribution` to set
   * credit/license (e.g. a PMC figure), pass `null` to clear it, or omit it to keep the current
   * attribution when the URL is unchanged (and clear it when the URL changes).
   */
  async updateQuestionImage(
    id: string,
    imageUrl: string | null,
    imageAlt: string | null,
    attribution?: QuestionImageAttribution | null,
  ): Promise<boolean> {
    await this.ensureQuestionsImageColumns();
    const [existing] = await db
      .select({ imageUrl: questions.imageUrl })
      .from(questions)
      .where(eq(questions.id, id));
    if (!existing) return false;
    const urlChanged = (existing.imageUrl ?? null) !== (imageUrl ?? null);
    const set: Partial<typeof questions.$inferInsert> = { imageUrl, imageAlt, updatedAt: new Date() };
    if (attribution !== undefined || urlChanged) {
      set.imageSourcePmcid = attribution?.pmcid ?? null;
      set.imageCredit = attribution?.credit ?? null;
      set.imageLicense = attribution?.license ?? null;
      set.imageSourceUrl = attribution?.sourceUrl ?? null;
    }
    const [updated] = await db
      .update(questions)
      .set(set)
      .where(eq(questions.id, id))
      .returning({ id: questions.id });
    return !!updated;
  }

  /** Idempotent schema needed by the question-fix agent (image attribution columns, proposals table). */
  async ensureQuestionAgentSchema(): Promise<void> {
    await this.ensureQuestionsImageColumns();
    await this.ensureFeedbackAgentTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "question_agent_proposals" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "question_id" varchar(128) NOT NULL,
        "status" varchar(16) DEFAULT 'pending' NOT NULL,
        "base_hash" varchar(64) NOT NULL,
        "previous_question" text NOT NULL,
        "previous_answer" text NOT NULL,
        "new_question" text,
        "new_answer" text,
        "image_url" varchar(512),
        "image_alt" varchar(256),
        "image_attribution" jsonb,
        "unhide" boolean DEFAULT false NOT NULL,
        "rationale" text,
        "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "run_id" varchar,
        "decided_by" varchar(64),
        "decision_note" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "decided_at" timestamp
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_agent_proposals_question_id" ON "question_agent_proposals" ("question_id")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_agent_proposals_status" ON "question_agent_proposals" ("status")`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "idx_question_agent_proposals_run_id" ON "question_agent_proposals" ("run_id")`
    );
  }

  async getQuestion(id: string) {
    const [row] = await db.select().from(questions).where(eq(questions.id, id));
    return row;
  }

  async getQuestionForReport(id: string): Promise<{
    question: string;
    answer: string;
    subsectionId: string;
    specialtyId: SpecialtyId;
  } | undefined> {
    const [row] = await db
      .select({
        question: questions.question,
        answer: questions.answer,
        subsectionId: questions.subsectionId,
        specialtyId: sections.specialtyId,
        sectionId: sections.id,
      })
      .from(questions)
      .innerJoin(subsections, eq(questions.subsectionId, subsections.id))
      .innerJoin(sections, eq(subsections.sectionId, sections.id))
      .where(eq(questions.id, id));
    if (!row) return undefined;
    const specialtyId: SpecialtyId =
      row.specialtyId === "ortho" || isOrthoContentId(row.sectionId) || isOrthoContentId(row.subsectionId)
        ? "ortho"
        : "prs";
    return {
      question: row.question,
      answer: row.answer,
      subsectionId: row.subsectionId,
      specialtyId,
    };
  }

  async getDraftGeneratedQuestions(): Promise<{
    id: string;
    question: string;
    answer: string;
    subsectionId: string;
    createdAt: Date;
    imageUrl: string | null;
    imageAlt: string | null;
  }[]> {
    await this.ensureQuestionsImageColumns();
    const rows = await db
      .select({
        id: questions.id,
        question: questions.question,
        answer: questions.answer,
        subsectionId: questions.subsectionId,
        createdAt: questions.createdAt,
        imageUrl: questions.imageUrl,
        imageAlt: questions.imageAlt,
      })
      .from(questions)
      .where(and(eq(questions.source, "generated"), eq(questions.visible, false)))
      .orderBy(desc(questions.createdAt));
    return rows;
  }

  // Topic Analytics operations
  async getTopicStats(userId: string, sectionId?: string): Promise<{
    sectionId: string;
    sectionTitle?: string;
    total: number;
    correct: number;
    accuracy: number;
  }[]> {
    const conditions: any[] = [eq(questionResponses.userId, userId)];
    if (sectionId) {
      conditions.push(eq(questionResponses.sectionId, sectionId));
    }

    const responses = await db
      .select()
      .from(questionResponses)
      .where(and(...conditions));

    // Group by section
    const statsMap = new Map<string, { total: number; correct: number }>();
    
    responses.forEach(r => {
      const key = r.sectionId;
      if (!statsMap.has(key)) {
        statsMap.set(key, { total: 0, correct: 0 });
      }
      const stats = statsMap.get(key)!;
      stats.total++;
      if (r.isCorrect) stats.correct++;
    });

    // Convert to array format
    return Array.from(statsMap.entries()).map(([sectionId, stats]) => ({
      sectionId,
      total: stats.total,
      correct: stats.correct,
      accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
    }));
  }

  // Subscription operations
  async initializeSubscriptionPlans(
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<SubscriptionPlan[]> {
    await this.ensureSubscriptionPlansSync();
    return this.getSubscriptionPlans(specialtyId);
  }

  /** Payment Link URLs (with free trial) – used when set; otherwise fallback to product/price. */
  private static readonly PAYMENT_LINK_URLS: Record<SpecialtyId, Record<string, string>> = {
    prs: {
      monthly: 'https://buy.stripe.com/28E14m4X6dd36H8f2pcV202',
      '6-month': 'https://buy.stripe.com/7sYeVc0GQ7SJc1saM9cV201',
      '1-year': 'https://buy.stripe.com/aFaaEW2OY3Ct6H88E1cV200',
    },
    ortho: {
      monthly: 'https://buy.stripe.com/9B6fZg61ac8Z3uWbQdcV20a',
      '6-month': 'https://buy.stripe.com/9B6aEWblu4Gx4z09I5cV20b',
      '1-year': 'https://buy.stripe.com/28E9AScpya0R9Tk8E1cV20c',
    },
  };

  /**
   * Payment Links without a free trial (same products/prices as above, no trial in Stripe Dashboard).
   * Paste URLs here and/or set env, e.g. STRIPE_PAYMENT_LINK_MONTHLY_NO_TRIAL (PRS) and
   * STRIPE_PAYMENT_LINK_ORTHO_MONTHLY_NO_TRIAL (Ortho).
   */
  private static readonly PAYMENT_LINK_URLS_NO_TRIAL: Record<SpecialtyId, Record<string, string>> = {
    prs: {
      monthly: 'https://buy.stripe.com/00w14m2OYb4VfdE5rPcV203',
      '6-month': 'https://buy.stripe.com/14A8wO9dmb4V8PgbQdcV204',
      '1-year': 'https://buy.stripe.com/14A8wOahq6OF3uWf2pcV205',
    },
    ortho: {
      monthly: 'https://buy.stripe.com/14AeVcfBKeh70iKbQdcV20d',
      '6-month': 'https://buy.stripe.com/00w00iexGb4V5D42fDcV20e',
      '1-year': 'https://buy.stripe.com/4gMbJ0cpyc8Z6H8bQdcV20f',
    },
  };

  /** Stripe product ids per specialty. Env `STRIPE_PRODUCT_ORTHO_*` overrides when set. */
  private static readonly STRIPE_PRODUCT_IDS: Record<SpecialtyId, Record<string, string>> = {
    prs: {
      monthly: 'prod_U14VnZW3eRgkDL',
      '6-month': 'prod_U14WP9DcWZEZWi',
      '1-year': 'prod_U14X6csDhWjhrk',
    },
    ortho: {
      monthly: 'prod_V218CzLt976UgM',
      '6-month': 'prod_V218kM9zJaPSBq',
      '1-year': 'prod_V218Mt3OZmOZ3P',
    },
  };

  /** `STRIPE_PAYMENT_LINK_MONTHLY…` for PRS; `STRIPE_PAYMENT_LINK_ORTHO_MONTHLY…` for Ortho. */
  private static envKey(specialtyId: SpecialtyId, planName: string, suffix: string): string {
    const planKey = planName.toUpperCase().replace(/-/g, '_');
    const specialtyKey = specialtyId === DEFAULT_SPECIALTY_ID ? '' : `${specialtyId.toUpperCase()}_`;
    return `STRIPE_PAYMENT_LINK_${specialtyKey}${planKey}${suffix}`;
  }

  private resolveTrialPaymentLink(specialtyId: SpecialtyId, planName: string): string {
    const fromEnv = process.env[DatabaseStorage.envKey(specialtyId, planName, '')]?.trim();
    if (fromEnv) return fromEnv;
    return (DatabaseStorage.PAYMENT_LINK_URLS[specialtyId]?.[planName] ?? '').trim();
  }

  private resolveNoTrialPaymentLink(specialtyId: SpecialtyId, planName: string): string {
    const fromEnv = process.env[DatabaseStorage.envKey(specialtyId, planName, '_NO_TRIAL')]?.trim();
    if (fromEnv) return fromEnv;
    return (DatabaseStorage.PAYMENT_LINK_URLS_NO_TRIAL[specialtyId]?.[planName] ?? '').trim();
  }

  private resolveStripeProductId(specialtyId: SpecialtyId, planName: string): string | null {
    const planKey = planName.toUpperCase().replace(/-/g, '_');
    const specialtyKey = specialtyId === DEFAULT_SPECIALTY_ID ? '' : `${specialtyId.toUpperCase()}_`;
    const fromEnv = process.env[`STRIPE_PRODUCT_${specialtyKey}${planKey}`]?.trim();
    if (fromEnv) return fromEnv;
    return DatabaseStorage.STRIPE_PRODUCT_IDS[specialtyId]?.[planName] ?? null;
  }

  /** Ensures DB columns for trial tracking and no-trial payment links exist (idempotent). */
  private async ensureSubscriptionTrialMigrations(): Promise<void> {
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_trial_used" boolean NOT NULL DEFAULT false
    `);
    await pool.query(`
      ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "stripe_payment_link_url_no_trial" varchar
    `);
    await pool.query(`
      ALTER TABLE "subscription_transactions" ADD COLUMN IF NOT EXISTS "stripe_invoice_id" varchar
    `);
    await pool.query(`
      ALTER TABLE "subscription_transactions" ADD COLUMN IF NOT EXISTS "canceled_at" timestamp
    `);
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_cancel_at_period_end" boolean NOT NULL DEFAULT false
    `);
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_canceled_at" timestamp
    `);
  }

  /**
   * One account per email, regardless of domain or capitalization.
   * Postgres UNIQUE(email) is case-sensitive, so Orr@x and orr@x could otherwise
   * become two passwords. Lowercase existing rows that do not collide, then
   * enforce uniqueness on lower(email).
   */
  private async ensureUsersEmailUniqueness(): Promise<void> {
    if (usersEmailUniquenessDone) return;
    usersEmailUniquenessDone = true;
    await pool.query(`
      UPDATE users AS u
      SET email = lower(u.email)
      WHERE u.email IS DISTINCT FROM lower(u.email)
        AND NOT EXISTS (
          SELECT 1 FROM users AS other
          WHERE other.id <> u.id AND lower(other.email) = lower(u.email)
        )
    `);
    try {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email_lower ON users (lower(email))`,
      );
    } catch (error) {
      console.error("Could not add unique index on lower(users.email):", error);
    }
  }

  /**
   * Multi-specialty columns + per-specialty entitlement table (drizzle/0016_multi_specialty.sql).
   * Idempotent; every pre-existing row belongs to Plastic Surgery so defaults are the backfill.
   */
  private async ensureMultiSpecialtyMigration(): Promise<void> {
    if (multiSpecialtyMigrationDone) return;
    multiSpecialtyMigrationDone = true;

    const columns: [string, string][] = [
      ["users", "active_specialty_id"],
      ["users", "signup_specialty_id"],
      ["sections", "specialty_id"],
      ["subscription_plans", "specialty_id"],
      ["subscription_transactions", "specialty_id"],
      ["institutional_codes", "specialty_id"],
      ["user_institutional_code_redemptions", "specialty_id"],
    ];
    for (const [table, column] of columns) {
      await pool.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" varchar(32) NOT NULL DEFAULT '${DEFAULT_SPECIALTY_ID}'`,
      );
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user_specialty_subscriptions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "specialty_id" varchar(32) NOT NULL,
        "subscription_status" varchar NOT NULL DEFAULT 'expired',
        "subscription_plan" varchar,
        "trial_ends_at" timestamp,
        "subscription_ends_at" timestamp,
        "subscription_cancel_at_period_end" boolean NOT NULL DEFAULT false,
        "subscription_canceled_at" timestamp,
        "stripe_subscription_id" varchar,
        "subscription_trial_used" boolean NOT NULL DEFAULT false,
        "institutional_access_affiliation" varchar,
        "institutional_access_expires_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )
    `);

    const indexes = [
      `CREATE UNIQUE INDEX IF NOT EXISTS "uidx_user_specialty_subscription" ON "user_specialty_subscriptions" ("user_id", "specialty_id")`,
      `CREATE INDEX IF NOT EXISTS "idx_user_specialty_subscriptions_user_id" ON "user_specialty_subscriptions" ("user_id")`,
      `CREATE INDEX IF NOT EXISTS "idx_user_specialty_subscriptions_stripe_sub" ON "user_specialty_subscriptions" ("stripe_subscription_id")`,
      `CREATE INDEX IF NOT EXISTS "idx_sections_specialty_id" ON "sections" ("specialty_id")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "uidx_subscription_plans_specialty_name" ON "subscription_plans" ("specialty_id", "name")`,
      `CREATE INDEX IF NOT EXISTS "idx_subscription_transactions_user_specialty" ON "subscription_transactions" ("user_id", "specialty_id")`,
      `CREATE INDEX IF NOT EXISTS "idx_user_institutional_redemptions_user_specialty" ON "user_institutional_code_redemptions" ("user_id", "specialty_id")`,
    ];
    for (const statement of indexes) {
      try {
        await pool.query(statement);
      } catch (err) {
        /** Duplicate plan names predating the unique index must not block startup. */
        console.warn("[multiSpecialtyMigration] index skipped:", statement, err);
      }
    }

    await pool.query(`
      INSERT INTO "user_specialty_subscriptions" (
        "user_id", "specialty_id", "subscription_status", "subscription_plan", "trial_ends_at",
        "subscription_ends_at", "subscription_cancel_at_period_end", "subscription_canceled_at",
        "stripe_subscription_id", "subscription_trial_used", "institutional_access_affiliation",
        "institutional_access_expires_at"
      )
      SELECT
        u."id", $1, COALESCE(u."subscription_status", 'expired'), u."subscription_plan",
        u."trial_ends_at", u."subscription_ends_at",
        COALESCE(u."subscription_cancel_at_period_end", false), u."subscription_canceled_at",
        u."stripe_subscription_id", COALESCE(u."subscription_trial_used", false),
        u."institutional_access_affiliation", u."institutional_access_expires_at"
      FROM "users" u
      ON CONFLICT ("user_id", "specialty_id") DO NOTHING
    `, [DEFAULT_SPECIALTY_ID]);

    /**
     * Same rule as ensureInstitutionalAccessRedemptionConsistencyMigration, applied to entitlement
     * rows created on an earlier boot: only a code redemption grants institutional access.
     */
    await pool.query(`
      UPDATE "user_specialty_subscriptions" e
      SET "institutional_access_affiliation" = NULL,
          "institutional_access_expires_at" = NULL,
          "updated_at" = now()
      WHERE NOT EXISTS (
        SELECT 1 FROM "user_institutional_code_redemptions" r
        WHERE r.user_id = e.user_id AND r.specialty_id = e.specialty_id
      )
      AND (
        (e.institutional_access_affiliation IS NOT NULL AND TRIM(e.institutional_access_affiliation) != '')
        OR e.institutional_access_expires_at IS NOT NULL
      )
    `);
  }

  /** Content-audit `flagged` column (drizzle/0018_questions_flagged.sql). Idempotent. */
  private async ensureQuestionsFlaggedColumn(): Promise<void> {
    if (questionsFlaggedColumnDone) return;
    questionsFlaggedColumnDone = true;
    await pool.query(
      `ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "flagged" boolean DEFAULT false NOT NULL`
    );
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS "idx_questions_flagged" ON "questions" ("flagged")`
      );
    } catch (err) {
      console.warn("[questionsFlagged] index skipped:", err);
    }
  }

  /** Question image columns (drizzle/0021_question_images.sql). Idempotent. */
  private async ensureQuestionsImageColumns(): Promise<void> {
    if (questionsImageColumnsDone) return;
    questionsImageColumnsDone = true;
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_url" varchar(512)`);
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_alt" varchar(256)`);
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_source_pmcid" varchar(32)`);
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_credit" varchar(512)`);
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_license" varchar(64)`);
    await pool.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "image_source_url" varchar(512)`);
  }

  private async ensureTestSessionsSpecialtyColumn(): Promise<void> {
    if (testSessionsSpecialtyColumnDone) return;
    testSessionsSpecialtyColumnDone = true;
    await pool.query(
      `ALTER TABLE "test_sessions" ADD COLUMN IF NOT EXISTS "specialty_id" varchar(32) NOT NULL DEFAULT 'prs'`
    );
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS "idx_test_sessions_user_specialty" ON "test_sessions" ("user_id", "specialty_id")`
      );
    } catch (err) {
      console.warn("[testSessionsSpecialty] index skipped:", err);
    }
    await pool.query(`
      UPDATE "test_sessions"
      SET "specialty_id" = 'ortho'
      WHERE "specialty_id" = 'prs'
        AND (
          COALESCE("selected_section_ids"::text, '') LIKE '%ortho-%'
          OR COALESCE("questions"::text, '') LIKE '%ortho-%'
        )
    `);
  }

  /** Call once at server startup so user rows match schema before any getUser(). */
  async warmupSubscriptionSchema(): Promise<void> {
    await this.ensureSubscriptionTrialMigrations();
    await this.ensureInstitutionalCodesTable();
    await this.ensureInstitutionalUserAccessColumnsMigration();
    await this.ensureQuestionsFlaggedColumn();
    await this.ensureQuestionsImageColumns();
    await this.ensureTestSessionsSpecialtyColumn();
    await this.ensureInstitutionalCodeRedeemedAtMigration();
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureInstitutionalAccessRedemptionConsistencyMigration();
    await this.ensureMultiSpecialtyMigration();
    await this.ensureAuthHandoffTables();
    await this.ensureFeedbackAgentTables();
    await this.ensureInstitutionalCodesSeed();
  }

  private async ensureAuthHandoffTables(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "auth_handoff_tokens" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "token_hash" varchar(64) NOT NULL,
        "target_specialty_id" varchar(32) NOT NULL,
        "next_path" varchar(512) NOT NULL DEFAULT '/',
        "continue_external_url" varchar(1024),
        "expires_at" timestamp NOT NULL,
        "used_at" timestamp,
        "created_at" timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uidx_auth_handoff_tokens_hash"
      ON "auth_handoff_tokens" ("token_hash")
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_auth_handoff_tokens_user_id"
      ON "auth_handoff_tokens" ("user_id")
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "pending_checkout_plans" (
        "user_id" varchar PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "plan_id" varchar NOT NULL REFERENCES "subscription_plans"("id") ON DELETE CASCADE,
        "specialty_id" varchar(32) NOT NULL DEFAULT 'prs',
        "updated_at" timestamp DEFAULT now() NOT NULL
      )
    `);
  }

  /** List prices are identical across specialties; Stripe products/links are not. */
  private static readonly PLAN_SHAPES = [
    { name: 'monthly', durationMonths: 1, priceUSD: 5000 },
    { name: '6-month', durationMonths: 6, priceUSD: 27000 },
    { name: '1-year', durationMonths: 12, priceUSD: 45000 },
  ] as const;

  private static readonly PLAN_NAMES = DatabaseStorage.PLAN_SHAPES.map((p) => p.name);

  /**
   * Ensures the three plans (monthly $50, 6-month $270, 1-year $450 list) exist for every specialty.
   * Legacy rows have no specialty column value other than the default, so they migrate in place.
   */
  async ensureSubscriptionPlansSync(): Promise<void> {
    await this.ensureSubscriptionTrialMigrations();
    await this.ensureMultiSpecialtyMigration();

    // Migrate old plan names to new (Plastic Surgery only — Ortho never had these).
    const legacyRenames: { from: string; to: string; durationMonths: number; priceUSD: number }[] = [
      { from: '1-month', to: 'monthly', durationMonths: 1, priceUSD: 5000 },
      { from: '3-month', to: '1-year', durationMonths: 12, priceUSD: 45000 },
    ];
    for (const rename of legacyRenames) {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.name, rename.from),
            eq(subscriptionPlans.specialtyId, DEFAULT_SPECIALTY_ID),
          ),
        );
      if (rows.length === 0) continue;
      await db
        .update(subscriptionPlans)
        .set({
          name: rename.to,
          durationMonths: rename.durationMonths,
          priceUSD: rename.priceUSD,
          stripeProductId: this.resolveStripeProductId(DEFAULT_SPECIALTY_ID, rename.to),
        })
        .where(
          and(
            eq(subscriptionPlans.name, rename.from),
            eq(subscriptionPlans.specialtyId, DEFAULT_SPECIALTY_ID),
          ),
        );
    }

    for (const specialtyId of SPECIALTY_IDS) {
      for (const shape of DatabaseStorage.PLAN_SHAPES) {
        const desired = {
          specialtyId,
          durationMonths: shape.durationMonths,
          priceUSD: shape.priceUSD,
          stripeProductId: this.resolveStripeProductId(specialtyId, shape.name),
          stripePaymentLinkUrl: this.resolveTrialPaymentLink(specialtyId, shape.name) || null,
          stripePaymentLinkUrlNoTrial: this.resolveNoTrialPaymentLink(specialtyId, shape.name) || null,
        };
        const scope = and(
          eq(subscriptionPlans.name, shape.name),
          eq(subscriptionPlans.specialtyId, specialtyId),
        );
        const existing = await db.select().from(subscriptionPlans).where(scope);
        if (existing.length === 0) {
          await db.insert(subscriptionPlans).values({ name: shape.name, ...desired });
        } else {
          await db.update(subscriptionPlans).set(desired).where(scope);
        }
      }
    }
  }

  async getSubscriptionPlans(
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<SubscriptionPlan[]> {
    await this.ensureSubscriptionPlansSync();
    const target = getSpecialty(specialtyId).id;
    const all = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.specialtyId, target))
      .orderBy(subscriptionPlans.durationMonths);
    const seen = new Set<string>();
    return all.filter((p) => {
      if (!DatabaseStorage.PLAN_NAMES.includes(p.name as never) || seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  }

  async getSubscriptionPlanById(planId: string): Promise<SubscriptionPlan | undefined> {
    const id = planId?.trim();
    if (!id) return undefined;
    await this.ensureSubscriptionPlansSync();
    const [row] = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, id))
      .limit(1);
    return row;
  }

  async createSubscriptionTransaction(transaction: InsertSubscriptionTransaction): Promise<SubscriptionTransaction> {
    const [created] = await db
      .insert(subscriptionTransactions)
      .values(transaction)
      .returning();
    return created;
  }

  async getUserActiveSubscription(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<SubscriptionTransaction | undefined> {
    await this.ensureMultiSpecialtyMigration();
    const now = new Date();
    const active = await db
      .select()
      .from(subscriptionTransactions)
      .where(
        and(
          eq(subscriptionTransactions.userId, userId),
          eq(subscriptionTransactions.specialtyId, getSpecialty(specialtyId).id),
          eq(subscriptionTransactions.status, 'completed'),
          lte(subscriptionTransactions.startDate, now)
        )
      )
      .orderBy(desc(subscriptionTransactions.endDate))
      .limit(1);
    return active[0];
  }

  /**
   * Cancel personal subscription:
   * - Active paid subscription: cancel at period end (no further renewal; access remains until existing end date).
   * - Active trial: cancel immediately (trial ends now; no conversion charge).
   * User content (responses, notes, bookmarks) is never deleted.
   */
  async cancelUserSubscription(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<void> {
    const target = getSpecialty(specialtyId).id;
    const entitlement = await this.getSpecialtyEntitlement(userId, target);

    const activeTx = await this.getUserActiveSubscription(userId, target);
    const canceledNow = new Date();

    const trialEndsAt = entitlement.trialEndsAt ? new Date(entitlement.trialEndsAt) : null;
    const inActiveTrial =
      (entitlement.subscriptionStatus || "").toLowerCase() === "trial" &&
      !!trialEndsAt &&
      trialEndsAt.getTime() > canceledNow.getTime();

    if (inActiveTrial) {
      if (entitlement.stripeSubscriptionId?.trim()) {
        const { cancelStripeSubscriptionImmediately } = await import("./stripe");
        await cancelStripeSubscriptionImmediately(entitlement.stripeSubscriptionId.trim());
      }

      if (activeTx) {
        await db
          .update(subscriptionTransactions)
          .set({
            status: "canceled",
            canceledAt: canceledNow,
          })
          .where(eq(subscriptionTransactions.id, activeTx.id));
      }

      await this.updateSpecialtyEntitlement(userId, target, {
        subscriptionStatus: "expired",
        subscriptionPlan: null,
        subscriptionEndsAt: null,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionCanceledAt: canceledNow,
        trialEndsAt: null,
        stripeSubscriptionId: null,
        subscriptionTrialUsed: true,
      });
      return;
    }

    if (entitlement.stripeSubscriptionId?.trim()) {
      const { cancelStripeSubscriptionAtPeriodEnd } = await import("./stripe");
      await cancelStripeSubscriptionAtPeriodEnd(entitlement.stripeSubscriptionId.trim());
    }

    if (activeTx) {
      await db
        .update(subscriptionTransactions)
        .set({
          status: "canceled",
          canceledAt: canceledNow,
        })
        .where(eq(subscriptionTransactions.id, activeTx.id));
    }

    const activeEnd = activeTx?.endDate ? new Date(activeTx.endDate) : null;
    const entitlementEnd = entitlement.subscriptionEndsAt
      ? new Date(entitlement.subscriptionEndsAt)
      : null;
    const periodEnd =
      entitlementEnd && activeEnd
        ? entitlementEnd.getTime() > activeEnd.getTime()
          ? entitlementEnd
          : activeEnd
        : entitlementEnd ?? activeEnd;

    await this.updateSpecialtyEntitlement(userId, target, {
      subscriptionStatus: "active",
      subscriptionEndsAt: periodEnd ?? entitlementEnd ?? null,
      subscriptionCancelAtPeriodEnd: true,
      subscriptionCanceledAt: canceledNow,
      trialEndsAt: null,
      subscriptionTrialUsed: true,
    });
  }

  async getUserSubscriptionTransactions(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<SubscriptionTransaction[]> {
    await this.ensureMultiSpecialtyMigration();
    return await db
      .select()
      .from(subscriptionTransactions)
      .where(
        and(
          eq(subscriptionTransactions.userId, userId),
          eq(subscriptionTransactions.specialtyId, getSpecialty(specialtyId).id),
        ),
      )
      .orderBy(desc(subscriptionTransactions.createdAt));
  }

  async getSubscriptionTransactionByStripeInvoiceId(
    invoiceId: string
  ): Promise<SubscriptionTransaction | undefined> {
    const id = invoiceId?.trim();
    if (!id) return undefined;
    const [row] = await db
      .select()
      .from(subscriptionTransactions)
      .where(eq(subscriptionTransactions.stripeInvoiceId, id))
      .limit(1);
    return row;
  }

  async getEntitlementByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<UserSpecialtySubscription | undefined> {
    const sid = stripeSubscriptionId?.trim();
    if (!sid) return undefined;
    await this.ensureMultiSpecialtyMigration();
    const [row] = await db
      .select()
      .from(userSpecialtySubscriptions)
      .where(eq(userSpecialtySubscriptions.stripeSubscriptionId, sid))
      .limit(1);
    return row;
  }

  async getEntitlementsWithStripeSubscriptions(): Promise<UserSpecialtySubscription[]> {
    await this.ensureMultiSpecialtyMigration();
    const rows = await db.select().from(userSpecialtySubscriptions);
    return rows.filter((row) => !!row.stripeSubscriptionId?.trim());
  }

  async getIntroTrialEligibility(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<boolean> {
    const target = getSpecialty(specialtyId).id;
    const user = await this.getUser(userId);
    if (!user) return false;
    const entitlement = await this.getSpecialtyEntitlement(userId, target);
    /**
     * Trial-code redemptions do not consume this flag and do not write subscription_transactions,
     * so a 30-day trial code still leaves the 7-day Stripe intro trial available.
     */
    if (entitlement.subscriptionTrialUsed) return false;
    const [row] = await db
      .select({ id: subscriptionTransactions.id })
      .from(subscriptionTransactions)
      .where(
        and(
          eq(subscriptionTransactions.userId, userId),
          eq(subscriptionTransactions.specialtyId, target),
          inArray(subscriptionTransactions.status, ["completed", "canceled"])
        )
      )
      .limit(1);
    if (row) return false;
    return true;
  }

  // Ensure institutional_codes table exists (idempotent; safe if migration wasn't run)
  private async ensureInstitutionalCodesTable(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "institutional_codes" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "code_hash" varchar NOT NULL UNIQUE,
        "institution_name" varchar NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      ALTER TABLE "institutional_codes" ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true
    `);
    await pool.query(`
      ALTER TABLE "institutional_codes"
      ADD COLUMN IF NOT EXISTS "code_type" varchar(32) NOT NULL DEFAULT 'institutional'
    `);
    await pool.query(`
      ALTER TABLE "institutional_codes"
      ADD COLUMN IF NOT EXISTS "redeem_expires_at" timestamp
    `);
    await pool.query(`
      ALTER TABLE "institutional_codes"
      ADD COLUMN IF NOT EXISTS "max_redemptions" integer
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_institutional_codes_code_hash" ON "institutional_codes" USING btree ("code_hash")
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_institutional_codes_active" ON "institutional_codes" USING btree ("active")
    `);
  }

  /**
   * Add institutional access columns only. Profile `institutional_affiliation` is display/settings only and must
   * never grant access — access comes only from redeeming a code (redemptions table + these columns).
   */
  private async ensureInstitutionalUserAccessColumnsMigration(): Promise<void> {
    if (institutionalUserColumnsMigrationDone) return;
    institutionalUserColumnsMigrationDone = true;
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "institutional_access_affiliation" varchar
    `);
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "institutional_access_expires_at" timestamp
    `);
  }

  /**
   * Strip access fields for users with no code redemptions; backfill expiry for redeemers missing it.
   * Runs after `user_institutional_code_redemptions` exists.
   */
  private async ensureInstitutionalAccessRedemptionConsistencyMigration(): Promise<void> {
    if (institutionalRedemptionConsistencyMigrationDone) return;
    institutionalRedemptionConsistencyMigrationDone = true;
    await pool.query(`
      UPDATE "users" u
      SET "institutional_access_affiliation" = NULL,
          "institutional_access_expires_at" = NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "user_institutional_code_redemptions" r WHERE r.user_id = u.id
      )
      AND (
        (u.institutional_access_affiliation IS NOT NULL AND TRIM(u.institutional_access_affiliation) != '')
        OR u.institutional_access_expires_at IS NOT NULL
      )
    `);
    await pool.query(`
      UPDATE "users" u
      SET "institutional_access_expires_at" = CURRENT_TIMESTAMP + INTERVAL '365 days'
      WHERE EXISTS (
        SELECT 1 FROM "user_institutional_code_redemptions" r WHERE r.user_id = u.id
      )
      AND u.institutional_access_expires_at IS NULL
    `);
  }

  /** Legacy column; no longer used to gate redemption (per-code redemptions table is authoritative). */
  private async ensureInstitutionalCodeRedeemedAtMigration(): Promise<void> {
    await pool.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "institutional_code_redeemed_at" timestamp
    `);
  }

  private async ensureUserInstitutionalRedemptionsTable(): Promise<void> {
    if (userInstitutionalRedemptionsTableDone) return;
    userInstitutionalRedemptionsTableDone = true;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user_institutional_code_redemptions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "institutional_code_id" varchar NOT NULL REFERENCES "institutional_codes"("id") ON DELETE CASCADE,
        "redeemed_at" timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uidx_user_institutional_code"
      ON "user_institutional_code_redemptions" ("user_id", "institutional_code_id")
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_institutional_redemptions_user_id"
      ON "user_institutional_code_redemptions" ("user_id")
    `);
  }

  /**
   * When RUN_SUBSCRIPTION_RESET=true, once per process: delete all subscription_transactions and clear
   * subscription + institutional access fields on every user. Preserves accounts, progress, notes, etc.
   * Unset env after deploy. Does not cancel Stripe — do that in Dashboard if needed.
   */
  private async ensureSubscriptionResetMigration(): Promise<void> {
    if (subscriptionResetDone || process.env.RUN_SUBSCRIPTION_RESET !== 'true') return;
    subscriptionResetDone = true;
    const { runFullSubscriptionDataReset } = await import("./subscriptionFullReset");
    const result = await runFullSubscriptionDataReset(pool);
    console.warn("[RUN_SUBSCRIPTION_RESET] Full subscription data reset:", result);
  }

  // Institutional codes (hashed in DB)
  async ensureInstitutionalCodesSeed(): Promise<void> {
    await this.ensureInstitutionalCodesTable();
    await this.ensureInstitutionalUserAccessColumnsMigration();
    await this.ensureInstitutionalCodeRedeemedAtMigration();
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureInstitutionalAccessRedemptionConsistencyMigration();
    await this.ensureSubscriptionResetMigration();

    const existing = await db.select().from(institutionalCodes).limit(1);
    if (existing.length === 0) {
      const codeHash = await bcrypt.hash("1127", INSTITUTIONAL_CODE_SALT_ROUNDS);
      await db.insert(institutionalCodes).values({
        codeHash,
        institutionName: "Emory University",
        active: true,
      });
    }

    await this.ensureBuiltinInstitutionalCode(
      SOCIALMEDIA_INSTITUTIONAL_CODE,
      "Social Media"
    );
    await this.ensureBuiltinInstitutionalCode(
      IOWA_TRIAL_CODE,
      "University of Iowa",
      { codeType: "trial" },
    );
    await this.ensureBuiltinInstitutionalCode(
      TEMPLE_TRIAL_CODE,
      "Temple University",
      { codeType: "trial" },
    );
    await this.ensureBuiltinInstitutionalCode(
      NUMC_TRIAL_CODE,
      "Nassau University Medical Center",
      { codeType: "trial" },
    );
    await this.ensureBuiltinInstitutionalCode(
      PRSATLAS30_CODE,
      "PRS Atlas",
      { specialtyId: "prs", maxRedemptions: 1 },
    );
  }

  /** Idempotent: inserts a built-in code when no row matches the plaintext; updates codeType when needed. */
  private async ensureBuiltinInstitutionalCode(
    plaintext: string,
    institutionName: string,
    options?: {
      codeType?: InstitutionalCodeType;
      specialtyId?: SpecialtyId;
      maxRedemptions?: number;
    },
  ): Promise<void> {
    const codeType = options?.codeType ?? "institutional";
    const specialtyId = getSpecialty(options?.specialtyId ?? DEFAULT_SPECIALTY_ID).id;
    const now = new Date();
    const rows = await db.select().from(institutionalCodes);
    for (const row of rows) {
      const match = await bcrypt.compare(plaintext, row.codeHash);
      if (match) {
        const updates: {
          codeType?: InstitutionalCodeType;
          institutionName?: string;
          specialtyId?: SpecialtyId;
          redeemExpiresAt?: Date | null;
          maxRedemptions?: number | null;
        } = {};
        if (parseInstitutionalCodeType(row.codeType) !== codeType) {
          updates.codeType = codeType;
        }
        if (institutionName && row.institutionName !== institutionName) {
          updates.institutionName = institutionName;
        }
        if (row.specialtyId !== specialtyId) {
          updates.specialtyId = specialtyId;
        }
        if (options?.maxRedemptions != null && row.maxRedemptions !== options.maxRedemptions) {
          updates.maxRedemptions = options.maxRedemptions;
        }
        /** Built-in trial codes get a 90-day redemption window from creation. */
        if (!row.redeemExpiresAt && options?.codeType === "trial") {
          updates.redeemExpiresAt = redeemExpiresAtFromCreatedAt(row.createdAt ?? now, now);
        }
        if (Object.keys(updates).length > 0) {
          await db.update(institutionalCodes).set(updates).where(eq(institutionalCodes.id, row.id));
        }
        return;
      }
    }
    const codeHash = await bcrypt.hash(plaintext, INSTITUTIONAL_CODE_SALT_ROUNDS);
    const createdAt = now;
    await db.insert(institutionalCodes).values({
      codeHash,
      institutionName,
      specialtyId,
      codeType,
      active: true,
      createdAt,
      maxRedemptions: options?.maxRedemptions,
      redeemExpiresAt:
        options?.codeType === "trial"
          ? redeemExpiresAtFromCreatedAt(createdAt, now)
          : undefined,
    });
  }

  async runSubscriptionResetIfRequested(): Promise<void> {
    await this.ensureSubscriptionResetMigration();
  }

  async resolveInstitutionalCode(plainCode: string): Promise<
    | {
        type: "ok";
        institutionName: string;
        codeId: string;
        specialtyId: SpecialtyId;
        codeType: InstitutionalCodeType;
        maxRedemptions: number | null;
      }
    | { type: "inactive" }
    | { type: "redeem_expired" }
    | { type: "exhausted" }
    | { type: "not_found" }
  > {
    await this.ensureInstitutionalCodesSeed();
    const rows = await db.select().from(institutionalCodes);
    const trimmed = plainCode.trim();
    if (!trimmed) return { type: "not_found" };
    for (const row of rows) {
      const match = await bcrypt.compare(trimmed, row.codeHash);
      if (match) {
        const maxRedemptions = row.maxRedemptions ?? null;
        if (maxRedemptions != null) {
          const used = await this.countInstitutionalCodeRedemptions(row.id);
          if (used >= maxRedemptions) return { type: "exhausted" };
        }
        if (row.active === false) return { type: "inactive" };
        if (!isCodeRedeemWindowOpen(row.redeemExpiresAt)) return { type: "redeem_expired" };
        return {
          type: "ok",
          institutionName: row.institutionName,
          codeId: row.id,
          specialtyId: getSpecialty(row.specialtyId).id,
          codeType: parseInstitutionalCodeType(row.codeType),
          maxRedemptions,
        };
      }
    }
    return { type: "not_found" };
  }

  private async countInstitutionalCodeRedemptions(institutionalCodeId: string): Promise<number> {
    await this.ensureUserInstitutionalRedemptionsTable();
    const [row] = await db
      .select({ n: count() })
      .from(userInstitutionalCodeRedemptions)
      .where(eq(userInstitutionalCodeRedemptions.institutionalCodeId, institutionalCodeId));
    return Number(row?.n ?? 0);
  }

  async validateInstitutionalCode(plainCode: string): Promise<string | null> {
    const r = await this.resolveInstitutionalCode(plainCode);
    return r.type === "ok" ? r.institutionName : null;
  }

  async getInstitutionalCodesAdmin(): Promise<
    {
      id: string;
      institutionName: string;
      specialtyId: SpecialtyId;
      codeType: InstitutionalCodeType;
      active: boolean;
      createdAt: Date | null;
      redeemExpiresAt: Date | null;
    }[]
  > {
    await this.ensureInstitutionalCodesSeed();
    const rows = await db
      .select({
        id: institutionalCodes.id,
        institutionName: institutionalCodes.institutionName,
        specialtyId: institutionalCodes.specialtyId,
        codeType: institutionalCodes.codeType,
        active: institutionalCodes.active,
        createdAt: institutionalCodes.createdAt,
        redeemExpiresAt: institutionalCodes.redeemExpiresAt,
      })
      .from(institutionalCodes)
      .orderBy(desc(institutionalCodes.createdAt));
    return rows.map((r) => ({
      id: r.id,
      institutionName: r.institutionName,
      specialtyId: getSpecialty(r.specialtyId).id,
      codeType: parseInstitutionalCodeType(r.codeType),
      active: r.active !== false,
      createdAt: r.createdAt ?? null,
      redeemExpiresAt: r.redeemExpiresAt ?? null,
    }));
  }

  async createInstitutionalCodeAdmin(
    plainCode: string,
    institutionName: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
    codeType: InstitutionalCodeType = "institutional",
  ): Promise<{ id: string; redeemExpiresAt: Date }> {
    await this.ensureInstitutionalCodesSeed();
    const trimmed = normalizeInstitutionalCodeForLookup(plainCode);
    const name = institutionName.trim();
    if (!trimmed || !name) {
      throw new Error("plainCode and institutionName are required");
    }
    /** Bcrypt salts differ per row — detect duplicate plaintext by comparing against existing hashes. */
    const duplicate = await this.resolveInstitutionalCode(trimmed);
    if (duplicate.type !== "not_found") {
      const err = new Error("An institutional code with this exact value already exists.");
      (err as NodeJS.ErrnoException).code = "23505";
      throw err;
    }
    const now = new Date();
    const redeemExpiresAt = redeemExpiresAtFromCreatedAt(now, now);
    const codeHash = await bcrypt.hash(trimmed, INSTITUTIONAL_CODE_SALT_ROUNDS);
    const [inserted] = await db
      .insert(institutionalCodes)
      .values({
        codeHash,
        institutionName: name,
        specialtyId: getSpecialty(specialtyId).id,
        codeType: parseInstitutionalCodeType(codeType),
        active: true,
        createdAt: now,
        redeemExpiresAt,
      })
      .returning({ id: institutionalCodes.id });
    if (!inserted) throw new Error("Insert failed");
    return { id: inserted.id, redeemExpiresAt };
  }

  async setInstitutionalCodeActiveAdmin(id: string, active: boolean): Promise<boolean> {
    await this.ensureInstitutionalCodesSeed();
    const [updated] = await db
      .update(institutionalCodes)
      .set({ active })
      .where(eq(institutionalCodes.id, id))
      .returning({ id: institutionalCodes.id });
    return !!updated;
  }

  async hasUserRedeemedInstitutionalCode(userId: string, institutionalCodeId: string): Promise<boolean> {
    await this.ensureUserInstitutionalRedemptionsTable();
    const [row] = await db
      .select({ id: userInstitutionalCodeRedemptions.id })
      .from(userInstitutionalCodeRedemptions)
      .where(
        and(
          eq(userInstitutionalCodeRedemptions.userId, userId),
          eq(userInstitutionalCodeRedemptions.institutionalCodeId, institutionalCodeId)
        )
      )
      .limit(1);
    return !!row;
  }

  async hasUserRedeemedAnyTrialCode(userId: string): Promise<boolean> {
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureInstitutionalCodesTable();
    const [row] = await db
      .select({ id: userInstitutionalCodeRedemptions.id })
      .from(userInstitutionalCodeRedemptions)
      .innerJoin(
        institutionalCodes,
        eq(userInstitutionalCodeRedemptions.institutionalCodeId, institutionalCodes.id),
      )
      .where(
        and(
          eq(userInstitutionalCodeRedemptions.userId, userId),
          eq(institutionalCodes.codeType, "trial"),
        ),
      )
      .limit(1);
    return !!row;
  }

  async getLatestInstitutionalCodeGrant(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<{
    codeType: InstitutionalCodeType;
    institutionName: string;
    redeemedAt: Date | null;
  } | null> {
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureInstitutionalCodesTable();
    await this.ensureMultiSpecialtyMigration();
    const [row] = await db
      .select({
        codeType: institutionalCodes.codeType,
        institutionName: institutionalCodes.institutionName,
        redeemedAt: userInstitutionalCodeRedemptions.redeemedAt,
      })
      .from(userInstitutionalCodeRedemptions)
      .innerJoin(
        institutionalCodes,
        eq(userInstitutionalCodeRedemptions.institutionalCodeId, institutionalCodes.id),
      )
      .where(
        and(
          eq(userInstitutionalCodeRedemptions.userId, userId),
          eq(userInstitutionalCodeRedemptions.specialtyId, getSpecialty(specialtyId).id),
        ),
      )
      .orderBy(desc(userInstitutionalCodeRedemptions.redeemedAt))
      .limit(1);
    if (!row) return null;
    return {
      codeType: parseInstitutionalCodeType(row.codeType),
      institutionName: row.institutionName,
      redeemedAt: row.redeemedAt ?? null,
    };
  }

  async recordInstitutionalCodeRedemption(
    userId: string,
    institutionalCodeId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
    grant?: { institutionName: string; expiresAt: Date },
  ): Promise<{ ok: true } | { ok: false; reason: "exhausted" | "already_redeemed" }> {
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureMultiSpecialtyMigration();
    const target = getSpecialty(specialtyId).id;
    if (grant) {
      await this.getSpecialtyEntitlement(userId, target);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const codeRes = await client.query<{
        id: string;
        max_redemptions: number | null;
      }>(
        `SELECT id, max_redemptions FROM "institutional_codes" WHERE id = $1 FOR UPDATE`,
        [institutionalCodeId],
      );
      const codeRow = codeRes.rows[0];
      if (!codeRow) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "exhausted" };
      }
      const existing = await client.query(
        `SELECT id FROM "user_institutional_code_redemptions"
         WHERE user_id = $1 AND institutional_code_id = $2
         LIMIT 1`,
        [userId, institutionalCodeId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "already_redeemed" };
      }
      const usedRes = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "user_institutional_code_redemptions" WHERE institutional_code_id = $1`,
        [institutionalCodeId],
      );
      const used = usedRes.rows[0]?.n ?? 0;
      if (codeRow.max_redemptions != null && used >= codeRow.max_redemptions) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "exhausted" };
      }
      await client.query(
        `INSERT INTO "user_institutional_code_redemptions" ("user_id", "institutional_code_id", "specialty_id")
         VALUES ($1, $2, $3)`,
        [userId, institutionalCodeId, target],
      );
      if (grant) {
        await client.query(
          `UPDATE "user_specialty_subscriptions"
           SET "institutional_access_affiliation" = $1,
               "institutional_access_expires_at" = $2,
               "updated_at" = NOW()
           WHERE "user_id" = $3 AND "specialty_id" = $4`,
          [grant.institutionName, grant.expiresAt, userId, target],
        );
        if (target === DEFAULT_SPECIALTY_ID) {
          await client.query(
            `UPDATE "users"
             SET "institutional_access_affiliation" = $1,
                 "institutional_access_expires_at" = $2,
                 "updated_at" = NOW()
             WHERE "id" = $3`,
            [grant.institutionName, grant.expiresAt, userId],
          );
        }
      }
      if (codeRow.max_redemptions != null && used + 1 >= codeRow.max_redemptions) {
        await client.query(`UPDATE "institutional_codes" SET active = false WHERE id = $1`, [
          institutionalCodeId,
        ]);
      }
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async userHasAnyInstitutionalRedemption(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<boolean> {
    await this.ensureUserInstitutionalRedemptionsTable();
    await this.ensureMultiSpecialtyMigration();
    const [row] = await db
      .select({ id: userInstitutionalCodeRedemptions.id })
      .from(userInstitutionalCodeRedemptions)
      .where(
        and(
          eq(userInstitutionalCodeRedemptions.userId, userId),
          eq(userInstitutionalCodeRedemptions.specialtyId, getSpecialty(specialtyId).id),
        ),
      )
      .limit(1);
    return !!row;
  }

  async ensureInstitutionalAccessExpiryWhenMissing(
    userId: string,
    userHint?: User | undefined,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<void> {
    const target = getSpecialty(specialtyId).id;
    const hasRedemption = await this.userHasAnyInstitutionalRedemption(userId, target);
    if (!hasRedemption) return;
    const entitlement = await this.getSpecialtyEntitlement(userId, target);
    if (entitlement.institutionalAccessExpiresAt) return;
    const grant = await this.getLatestInstitutionalCodeGrant(userId, target);
    const days = grant?.codeType === "trial" ? TRIAL_CODE_DURATION_DAYS : 365;
    const end = new Date();
    end.setDate(end.getDate() + days);
    await this.updateSpecialtyEntitlement(userId, target, { institutionalAccessExpiresAt: end });
  }

  // Theme preference operations
  async getThemePreference(userId: string): Promise<string> {
    const [user] = await db
      .select({ themePreference: users.themePreference })
      .from(users)
      .where(eq(users.id, userId));
    return user?.themePreference || 'light';
  }

  async updateThemePreference(userId: string, theme: string): Promise<string> {
    const [updated] = await db
      .update(users)
      .set({
        themePreference: theme,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ themePreference: users.themePreference });
    return updated?.themePreference || 'light';
  }

  // Percentile rank within one specialty's question bank (PRS vs Ortho are separate pools).
  async getUserPercentileRank(
    userId: string,
    specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
  ): Promise<number | null> {
    const target = getSpecialty(specialtyId).id;
    const specialtySections = await db
      .select({ id: sections.id })
      .from(sections)
      .where(eq(sections.specialtyId, target));
    const sectionIds = specialtySections.map((s) => s.id);
    if (sectionIds.length === 0) return null;

    const userResponses = await db
      .select()
      .from(questionResponses)
      .where(
        and(
          eq(questionResponses.userId, userId),
          inArray(questionResponses.sectionId, sectionIds),
        ),
      );

    if (userResponses.length === 0) {
      return null;
    }

    const userCorrect = userResponses.filter((r) => r.isCorrect).length;
    const userAccuracy = (userCorrect / userResponses.length) * 100;

    // Only compare against users who have answered questions in this specialty.
    const peerRows = await db
      .select({
        userId: questionResponses.userId,
        isCorrect: questionResponses.isCorrect,
      })
      .from(questionResponses)
      .where(inArray(questionResponses.sectionId, sectionIds));

    const byUser = new Map<string, { total: number; correct: number }>();
    for (const row of peerRows) {
      const cur = byUser.get(row.userId) ?? { total: 0, correct: 0 };
      cur.total += 1;
      if (row.isCorrect) cur.correct += 1;
      byUser.set(row.userId, cur);
    }

    const peerCount = byUser.size;
    if (peerCount === 0) return null;

    let betterCount = 0;
    for (const stats of byUser.values()) {
      const accuracy = (stats.correct / stats.total) * 100;
      if (accuracy > userAccuracy) betterCount += 1;
    }

    const percentile = Math.round(((peerCount - betterCount) / peerCount) * 100);
    return Math.min(100, Math.max(0, percentile));
  }

  async createAuthHandoffToken(params: {
    userId: string;
    targetSpecialtyId: SpecialtyId;
    nextPath?: string;
    continueExternalUrl?: string | null;
  }): Promise<{ plainToken: string; expiresAt: Date }> {
    await this.ensureAuthHandoffTables();
    const { randomBytes, createHash } = await import("crypto");
    const plainToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(plainToken, "utf8").digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const nextPath = sanitizeHandoffNextPath(params.nextPath);
    const continueExternalUrl = sanitizeStripeContinueUrl(params.continueExternalUrl);
    await db.insert(authHandoffTokens).values({
      userId: params.userId,
      tokenHash,
      targetSpecialtyId: getSpecialty(params.targetSpecialtyId).id,
      nextPath,
      continueExternalUrl,
      expiresAt,
    });
    return { plainToken, expiresAt };
  }

  async consumeAuthHandoffToken(plainToken: string): Promise<{
    userId: string;
    targetSpecialtyId: SpecialtyId;
    nextPath: string;
    continueExternalUrl: string | null;
  } | null> {
    await this.ensureAuthHandoffTables();
    const trimmed = plainToken?.trim();
    if (!trimmed) return null;
    const { createHash } = await import("crypto");
    const tokenHash = createHash("sha256").update(trimmed, "utf8").digest("hex");
    const [row] = await db
      .select()
      .from(authHandoffTokens)
      .where(eq(authHandoffTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row || row.usedAt) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    await db
      .update(authHandoffTokens)
      .set({ usedAt: new Date() })
      .where(eq(authHandoffTokens.id, row.id));
    return {
      userId: row.userId,
      targetSpecialtyId: getSpecialty(row.targetSpecialtyId).id,
      nextPath: sanitizeHandoffNextPath(row.nextPath),
      continueExternalUrl: sanitizeStripeContinueUrl(row.continueExternalUrl),
    };
  }

  async setPendingCheckoutPlan(
    userId: string,
    planId: string,
    specialtyId: SpecialtyId,
  ): Promise<void> {
    await this.ensureAuthHandoffTables();
    await db
      .insert(pendingCheckoutPlans)
      .values({
        userId,
        planId,
        specialtyId: getSpecialty(specialtyId).id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pendingCheckoutPlans.userId,
        set: {
          planId,
          specialtyId: getSpecialty(specialtyId).id,
          updatedAt: new Date(),
        },
      });
  }

  async takePendingCheckoutPlan(
    userId: string,
  ): Promise<{ planId: string; specialtyId: SpecialtyId } | null> {
    await this.ensureAuthHandoffTables();
    const [row] = await db
      .select()
      .from(pendingCheckoutPlans)
      .where(eq(pendingCheckoutPlans.userId, userId))
      .limit(1);
    if (!row) return null;
    // Keep row until successful fulfill so webhook races / retries still resolve the plan.
    // Stale rows older than 48h are ignored.
    if (row.updatedAt.getTime() < Date.now() - 48 * 60 * 60 * 1000) {
      await db.delete(pendingCheckoutPlans).where(eq(pendingCheckoutPlans.userId, userId));
      return null;
    }
    return { planId: row.planId, specialtyId: getSpecialty(row.specialtyId).id };
  }

  async clearPendingCheckoutPlan(userId: string): Promise<void> {
    await this.ensureAuthHandoffTables();
    await db.delete(pendingCheckoutPlans).where(eq(pendingCheckoutPlans.userId, userId));
  }

  async createChatBubbleThread(threadId: string) {
    this.chatBubbleThreads.set(threadId, { id: threadId, messages: [] });
  }

  async getChatBubbleThread(threadId: string) {
    return this.chatBubbleThreads.get(threadId);
  }
}

/** Only same-site relative paths — blocks open redirects. */
function sanitizeHandoffNextPath(raw: string | null | undefined): string {
  const fallback = "/";
  if (!raw || typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  if (trimmed.includes("://") || trimmed.includes("\\")) return fallback;
  return trimmed.slice(0, 512) || fallback;
}

/** Payment Links only — never arbitrary external URLs. */
/** Payment Links are hosted on buy.stripe.com; Checkout Sessions on checkout.stripe.com. */
const STRIPE_CHECKOUT_HOSTS = new Set(["buy.stripe.com", "checkout.stripe.com"]);

function sanitizeStripeContinueUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    if (!STRIPE_CHECKOUT_HOSTS.has(u.hostname)) return null;
    return u.toString().slice(0, 1024);
  } catch {
    return null;
  }
}

export const storage = new DatabaseStorage();
