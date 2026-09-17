import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { DEFAULT_SPECIALTY_ID, type SpecialtyId } from "./specialties";

// Session storage table
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique().notNull(),
  passwordHash: varchar("password_hash"), // For email/password auth (nullable for OAuth users)
  username: varchar("username"),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  avatarIcon: varchar("avatar_icon").default('smile'),
  themePreference: varchar("theme_preference").default('light'), // 'system', 'light', or 'dark'
  institutionalAffiliation: varchar("institutional_affiliation"), // Profile only: user's registered/display affiliation (settings, signup)
  /** Signup-only; internal analytics. Not returned on SanitizedUser. */
  trainingLevel: varchar("training_level"),
  /** Question bank currently selected in the app; drives content, theme, and entitlement scope. */
  activeSpecialtyId: varchar("active_specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  /** Specialty chosen at signup (which domain/q-bank the account was created for). */
  signupSpecialtyId: varchar("signup_specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  institutionalAccessAffiliation: varchar("institutional_access_affiliation"), // Display name from last code redeem; access requires redemption row + future expires_at
  institutionalAccessExpiresAt: timestamp("institutional_access_expires_at"), // End of code-granted access; must be in the future (with a redemption) to unlock
  /** Legacy timestamp; redemption limits use `user_institutional_code_redemptions` (per code per account). */
  institutionalCodeRedeemedAt: timestamp("institutional_code_redeemed_at"),
  /**
   * Entitlement columns below are the legacy single-specialty shape and are kept in sync as the
   * Plastic Surgery mirror of `user_specialty_subscriptions`. Read/write per-specialty entitlement
   * through storage.getSpecialtyEntitlement / updateSpecialtyEntitlement, never these directly.
   */
  subscriptionStatus: varchar("subscription_status").default('trial'), // trial, active, expired
  subscriptionPlan: varchar("subscription_plan"), // 1-month, 3-month, 6-month
  trialEndsAt: timestamp("trial_ends_at"),
  subscriptionEndsAt: timestamp("subscription_ends_at"),
  subscriptionCancelAtPeriodEnd: boolean("subscription_cancel_at_period_end").notNull().default(false), // User canceled renewal; keep access until subscriptionEndsAt
  subscriptionCanceledAt: timestamp("subscription_canceled_at"), // When user requested cancellation (period-end for paid, immediate for trial)
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  /** Once true, user should use no-trial Payment Links / checkout (set on fulfill + cancel). */
  subscriptionTrialUsed: boolean("subscription_trial_used").notNull().default(false),
  passwordNeedsReset: boolean("password_needs_reset").default(false), // True if using temporary password
  tester: boolean("tester"), // True if user has beta access to Question Auth Platform (Atlas Trainer); set by admins; null/undefined treated as false
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("uidx_users_email_lower").on(sql`lower(${table.email})`),
]);

// Login connections table - tracks which OAuth providers user has connected
export const loginConnections = pgTable("login_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar("provider").notNull(), // 'google', 'apple', 'microsoft'
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_login_connections_user_id").on(table.userId),
]);

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type LoginConnection = typeof loginConnections.$inferSelect;

/** Single-use password reset tokens (only SHA-256 hashes stored; plaintext token exists only in the email link). */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("uidx_password_reset_tokens_hash").on(table.tokenHash),
    index("idx_password_reset_tokens_user_id").on(table.userId),
  ],
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// Test Sessions table - tracks user's test progress
export const testSessions = pgTable("test_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Which q-bank this test belongs to (PRS vs Ortho). */
  specialtyId: varchar("specialty_id", { length: 32 }).notNull().default("prs"),
  status: varchar("status", { length: 20 }).notNull().default('in-progress'),
  questionCount: integer("question_count").notNull(),
  useAllQuestions: boolean("use_all_questions").notNull().default(false),
  selectedSectionIds: jsonb("selected_section_ids").$type<string[]>().notNull(),
  questions: jsonb("questions").notNull(), // Store the full Question objects for resume
  currentQuestionIndex: integer("current_question_index").notNull().default(0),
  flaggedQuestionIds: jsonb("flagged_question_ids").$type<string[]>().default([]).notNull(), // Store IDs of flagged questions
  /** When true, the test uses a countdown; remaining seconds are stored for pause/resume. */
  timerEnabled: boolean("timer_enabled").notNull().default(false),
  timerRemainingSeconds: integer("timer_remaining_seconds"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_test_sessions_user_id").on(table.userId),
  index("idx_test_sessions_status").on(table.status),
  index("idx_test_sessions_user_specialty").on(table.userId, table.specialtyId),
]);

export type InsertTestSession = typeof testSessions.$inferInsert;
export type TestSession = typeof testSessions.$inferSelect;

// Question Responses table - tracks answers to individual questions (study mode and test mode)
export const questionResponses = pgTable("question_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  testSessionId: varchar("test_session_id").references(() => testSessions.id, { onDelete: 'cascade' }), // Nullable for study mode
  questionId: varchar("question_id").notNull(),
  sectionId: varchar("section_id").notNull(),
  subsectionId: varchar("subsection_id").notNull(),
  selectedAnswer: varchar("selected_answer").notNull(),
  correctAnswer: varchar("correct_answer").notNull().default(''), // The correct answer for reference
  isCorrect: boolean("is_correct").notNull(),
  answeredAt: timestamp("answered_at").defaultNow().notNull(),
}, (table) => [
  index("idx_question_responses_test_session").on(table.testSessionId),
  index("idx_question_responses_question").on(table.questionId),
  index("idx_question_responses_user").on(table.userId),
  index("idx_question_responses_section").on(table.sectionId),
  index("idx_question_responses_user_section").on(table.userId, table.sectionId),
]);

export type InsertQuestionResponse = typeof questionResponses.$inferInsert;
export type QuestionResponse = typeof questionResponses.$inferSelect;

// Notes table - tracks user notes on highlights
export const notes = pgTable("notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: varchar("content").notNull(),
  sectionId: varchar("section_id").notNull(),
  subsectionId: varchar("subsection_id").notNull(),
  location: varchar("location", { length: 20 }).notNull(), // 'reference' or 'question'
  questionId: varchar("question_id"),
  positionX: integer("position_x").notNull().default(100),
  positionY: integer("position_y").notNull().default(100),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_notes_user_id").on(table.userId),
  index("idx_notes_section").on(table.sectionId, table.subsectionId),
]);

export type InsertNote = typeof notes.$inferInsert;
export type Note = typeof notes.$inferSelect;

// Highlights table - tracks user's text highlights
export const highlights = pgTable("highlights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: varchar("text").notNull(),
  color: varchar("color", { length: 20 }).notNull().default('yellow'), // 'yellow', 'green', 'blue', 'pink'
  sectionId: varchar("section_id").notNull(),
  subsectionId: varchar("subsection_id").notNull(),
  location: varchar("location", { length: 20 }).notNull(), // 'reference' or 'question'
  questionId: varchar("question_id"),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_highlights_user_id").on(table.userId),
  index("idx_highlights_section").on(table.sectionId, table.subsectionId),
]);

export type InsertHighlight = typeof highlights.$inferInsert;
export type Highlight = typeof highlights.$inferSelect;

// Bookmarks table - tracks user's bookmarked questions
export const bookmarks = pgTable("bookmarks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  questionId: varchar("question_id").notNull(),
  sectionId: varchar("section_id").notNull(),
  subsectionId: varchar("subsection_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_bookmarks_user_id").on(table.userId),
  index("idx_bookmarks_question").on(table.questionId),
  index("idx_bookmarks_user_question").on(table.userId, table.questionId),
]);

export type InsertBookmark = typeof bookmarks.$inferInsert;
export type Bookmark = typeof bookmarks.$inferSelect;

// Spaced Repetition table - tracks SR algorithm state for questions
export const spacedRepetitions = pgTable("spaced_repetitions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  questionId: varchar("question_id").notNull(),
  sectionId: varchar("section_id").notNull(),
  subsectionId: varchar("subsection_id").notNull(),
  repetitionCount: integer("repetition_count").notNull().default(0),
  easeFactor: integer("ease_factor").notNull().default(2500), // Stored as integer * 100 (so 2.5 = 2500)
  interval: integer("interval").notNull().default(1), // Days until next review
  lastReviewedAt: timestamp("last_reviewed_at"),
  nextReviewAt: timestamp("next_review_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sr_user_id").on(table.userId),
  index("idx_sr_question").on(table.questionId),
  index("idx_sr_next_review").on(table.nextReviewAt),
  index("idx_sr_user_question").on(table.userId, table.questionId),
]);

export type InsertSpacedRepetition = typeof spacedRepetitions.$inferInsert;
export type SpacedRepetition = typeof spacedRepetitions.$inferSelect;

// Question bank: sections, subsections, questions (replaces Excel as source)
export const sections = pgTable("sections", {
  id: varchar("id", { length: 64 }).primaryKey(),
  /** Owning specialty. Section/subsection ids are globally unique via specialty prefixes. */
  specialtyId: varchar("specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  title: varchar("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [index("idx_sections_specialty_id").on(table.specialtyId)]);

export const subsections = pgTable("subsections", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sectionId: varchar("section_id", { length: 64 }).notNull().references(() => sections.id, { onDelete: "cascade" }),
  title: varchar("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [index("idx_subsections_section_id").on(table.sectionId)]);

export const questions = pgTable("questions", {
  id: varchar("id", { length: 128 }).primaryKey(),
  subsectionId: varchar("subsection_id", { length: 64 }).notNull().references(() => subsections.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  source: varchar("source", { length: 32 }).notNull().default("imported"), // 'imported' | 'generated'
  visible: boolean("visible").notNull().default(true), // false = hidden from users (e.g. picture-based)
  /** True once auto-hidden due to user report volume (>=10); stays true if visibility is restored by admin */
  reported: boolean("reported").notNull().default(false),
  /**
   * Content-audit flag (any specialty). When true the question is hidden from learners
   * until an admin clears the flag (unflag). Independent of `reported`.
   */
  flagged: boolean("flagged").notNull().default(false),
  /** Public URL path to a clinical image shown after the question stem (e.g. /question-images/foo.webp). */
  imageUrl: varchar("image_url", { length: 512 }),
  imageAlt: varchar("image_alt", { length: 256 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_questions_subsection_id").on(table.subsectionId),
  index("idx_questions_flagged").on(table.flagged),
]);

/**
 * Ledger of the last bundled q-bank export applied to this database.
 * Created at runtime by content bootstrap; declared here so `drizzle-kit push`
 * does not treat it as an unknown table and try to drop it.
 */
export const contentPromotions = pgTable("content_promotions", {
  specialtyId: varchar("specialty_id", { length: 32 }).primaryKey().$type<SpecialtyId>(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  exportedAt: timestamp("exported_at").notNull(),
  promotedAt: timestamp("promoted_at").defaultNow().notNull(),
  insertedQuestions: integer("inserted_questions").notNull().default(0),
});

export type InsertSection = typeof sections.$inferInsert;
export type SectionRow = typeof sections.$inferSelect;
export type InsertSubsection = typeof subsections.$inferInsert;
export type SubsectionRow = typeof subsections.$inferSelect;
export type InsertQuestion = typeof questions.$inferInsert;
export type QuestionRow = typeof questions.$inferSelect;

// Subscription Plans table - stores available plans
export const subscriptionPlans = pgTable("subscription_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Plans are per specialty: each q-bank has its own Stripe products / Payment Links. */
  specialtyId: varchar("specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  name: varchar("name").notNull(), // '1-month', '3-month', '6-month'
  durationMonths: integer("duration_months").notNull(),
  priceUSD: integer("price_usd").notNull(), // in cents: 2500 = $25.00
  stripePriceId: varchar("stripe_price_id"),
  stripeProductId: varchar("stripe_product_id"), // Stripe product id (prod_xxx) for Checkout
  stripePaymentLinkUrl: varchar("stripe_payment_link_url"), // Payment Link URL (with trial); preferred when set
  /** Payment Link URL without free trial — used for returning subscribers (same price/interval as trial link). */
  stripePaymentLinkUrlNoTrial: varchar("stripe_payment_link_url_no_trial"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_subscription_plans_name").on(table.name),
  uniqueIndex("uidx_subscription_plans_specialty_name").on(table.specialtyId, table.name),
]);

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = typeof subscriptionPlans.$inferInsert;

// Subscription Transactions table - tracks user purchases
export const subscriptionTransactions = pgTable("subscription_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Which q-bank this purchase paid for (denormalized from the plan for cheap filtering). */
  specialtyId: varchar("specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  planId: varchar("plan_id").notNull().references(() => subscriptionPlans.id),
  stripePaymentIntentId: varchar("stripe_payment_intent_id"),
  /** Stripe invoice id (in_xxx) when checkout created a subscription invoice — used for hosted invoice links */
  stripeInvoiceId: varchar("stripe_invoice_id"),
  amount: integer("amount").notNull(), // in cents
  /** pending | completed | failed | canceled (canceled = ended before period end; see canceledAt) */
  status: varchar("status").notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  /** When the subscription/access for this row was canceled (e.g. user canceled or Stripe sub deleted). */
  canceledAt: timestamp("canceled_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_subscription_transactions_user_id").on(table.userId),
  index("idx_subscription_transactions_status").on(table.status),
  index("idx_subscription_transactions_user_specialty").on(table.userId, table.specialtyId),
]);

export type SubscriptionTransaction = typeof subscriptionTransactions.$inferSelect;
export type InsertSubscriptionTransaction = typeof subscriptionTransactions.$inferInsert;

/**
 * Per-specialty entitlement: one row per (user, specialty). A single account may hold an active
 * Plastic Surgery subscription and an active Orthopaedic subscription at the same time, each with
 * its own Stripe subscription, trial usage, and institutional grant.
 *
 * The Plastic Surgery row is mirrored onto the legacy `users` columns so untouched code paths
 * (reconciliation scripts, admin tooling) keep working during the transition.
 */
export const userSpecialtySubscriptions = pgTable(
  "user_specialty_subscriptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    specialtyId: varchar("specialty_id", { length: 32 }).$type<SpecialtyId>().notNull(),
    subscriptionStatus: varchar("subscription_status").notNull().default("expired"),
    subscriptionPlan: varchar("subscription_plan"),
    trialEndsAt: timestamp("trial_ends_at"),
    subscriptionEndsAt: timestamp("subscription_ends_at"),
    subscriptionCancelAtPeriodEnd: boolean("subscription_cancel_at_period_end")
      .notNull()
      .default(false),
    subscriptionCanceledAt: timestamp("subscription_canceled_at"),
    stripeSubscriptionId: varchar("stripe_subscription_id"),
    /** Once true, this specialty uses no-trial Payment Links / checkout. */
    subscriptionTrialUsed: boolean("subscription_trial_used").notNull().default(false),
    institutionalAccessAffiliation: varchar("institutional_access_affiliation"),
    institutionalAccessExpiresAt: timestamp("institutional_access_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uidx_user_specialty_subscription").on(table.userId, table.specialtyId),
    index("idx_user_specialty_subscriptions_user_id").on(table.userId),
    index("idx_user_specialty_subscriptions_stripe_sub").on(table.stripeSubscriptionId),
  ],
);

export type UserSpecialtySubscription = typeof userSpecialtySubscriptions.$inferSelect;
export type InsertUserSpecialtySubscription = typeof userSpecialtySubscriptions.$inferInsert;

export const INSTITUTIONAL_CODE_TYPES = ["institutional", "trial"] as const;
export type InstitutionalCodeType = (typeof INSTITUTIONAL_CODE_TYPES)[number];

// Institutional access codes (code stored as bcrypt hash; never store plaintext)
export const institutionalCodes = pgTable("institutional_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  codeHash: varchar("code_hash").notNull().unique(),
  institutionName: varchar("institution_name").notNull(),
  /** A code unlocks exactly one q-bank. */
  specialtyId: varchar("specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  /**
   * `institutional`: 365-day program license.
   * `trial`: 30-day trial from redemption; once per account; does not consume the 7-day Stripe intro trial.
   */
  codeType: varchar("code_type", { length: 32 })
    .$type<InstitutionalCodeType>()
    .notNull()
    .default("institutional"),
  /** When false, the code cannot be redeemed. Already-granted access is unchanged. */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  /** After this timestamp, the code cannot be redeemed. Null = no redemption time limit (legacy codes). */
  redeemExpiresAt: timestamp("redeem_expires_at"),
  /** Null = unlimited accounts may redeem. `1` = a single redemption ever, then the code is spent. */
  maxRedemptions: integer("max_redemptions"),
}, (table) => [
  index("idx_institutional_codes_code_hash").on(table.codeHash),
  index("idx_institutional_codes_active").on(table.active),
]);

export type InstitutionalCode = typeof institutionalCodes.$inferSelect;
export type InsertInstitutionalCode = typeof institutionalCodes.$inferInsert;

/** Tracks which institutional codes each user has redeemed (same user cannot redeem the same code twice; unlimited other accounts may use the same code while it is active). */
export const userInstitutionalCodeRedemptions = pgTable(
  "user_institutional_code_redemptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Named FK: default Drizzle name exceeds Postgres' 63-char limit and causes infinite db:push renames.
    institutionalCodeId: varchar("institutional_code_id").notNull(),
    /** Denormalized from the code so entitlement checks stay specialty-scoped. */
    specialtyId: varchar("specialty_id", { length: 32 })
      .$type<SpecialtyId>()
      .notNull()
      .default(DEFAULT_SPECIALTY_ID),
    redeemedAt: timestamp("redeemed_at").defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "uicr_institutional_code_id_fk",
      columns: [table.institutionalCodeId],
      foreignColumns: [institutionalCodes.id],
    }).onDelete("cascade"),
    uniqueIndex("uidx_user_institutional_code").on(table.userId, table.institutionalCodeId),
    index("idx_user_institutional_redemptions_user_id").on(table.userId),
    index("idx_user_institutional_redemptions_user_specialty").on(table.userId, table.specialtyId),
  ]
);

export type UserInstitutionalCodeRedemption = typeof userInstitutionalCodeRedemptions.$inferSelect;
export type InsertUserInstitutionalCodeRedemption = typeof userInstitutionalCodeRedemptions.$inferInsert;

// Question reports - user-reported issues with questions (stored + Slack)
export const questionReports = pgTable("question_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  questionId: varchar("question_id", { length: 128 }).notNull(),
  message: text("message").notNull(),
  userEmail: varchar("user_email"), // null if submitted anonymously
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }), // null if anonymous
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_question_reports_question_id").on(table.questionId),
  index("idx_question_reports_created_at").on(table.createdAt),
]);

export type QuestionReport = typeof questionReports.$inferSelect;
export type InsertQuestionReport = typeof questionReports.$inferInsert;

export const contactMessages = pgTable(
  "contact_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 200 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    subject: varchar("subject", { length: 200 }).notNull(),
    message: text("message").notNull(),
    specialtyId: varchar("specialty_id", { length: 32 })
      .$type<SpecialtyId>()
      .notNull()
      .default(DEFAULT_SPECIALTY_ID),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_contact_messages_created_at").on(table.createdAt)]
);

export type ContactMessage = typeof contactMessages.$inferSelect;
export type InsertContactMessage = typeof contactMessages.$inferInsert;

export const questionRevisions = pgTable(
  "question_revisions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    questionId: varchar("question_id", { length: 128 }).notNull(),
    action: varchar("action", { length: 32 }).notNull(), // revise | needs_manual
    previousQuestion: text("previous_question"),
    previousAnswer: text("previous_answer"),
    newQuestion: text("new_question"),
    newAnswer: text("new_answer"),
    source: varchar("source", { length: 64 }).notNull().default("feedback_agent"),
    rationale: text("rationale"),
    reportIds: jsonb("report_ids").$type<string[]>().default([]).notNull(),
    runId: varchar("run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_question_revisions_question_id").on(table.questionId),
    index("idx_question_revisions_created_at").on(table.createdAt),
    index("idx_question_revisions_run_id").on(table.runId),
  ]
);

export type QuestionRevision = typeof questionRevisions.$inferSelect;
export type InsertQuestionRevision = typeof questionRevisions.$inferInsert;

export const agentJobRuns = pgTable(
  "agent_job_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    jobName: varchar("job_name", { length: 64 }).notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    stats: jsonb("stats").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    index("idx_agent_job_runs_job_name").on(table.jobName),
    index("idx_agent_job_runs_started_at").on(table.startedAt),
  ]
);

export type AgentJobRun = typeof agentJobRuns.$inferSelect;
export type InsertAgentJobRun = typeof agentJobRuns.$inferInsert;

/** Distilled rules both the feedback editor and question generator inject into prompts. */
export const agentLessons = pgTable(
  "agent_lessons",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    category: varchar("category", { length: 64 }).notNull(),
    lesson: text("lesson").notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    source: varchar("source", { length: 64 }).notNull().default("feedback_agent"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uidx_agent_lessons_fingerprint").on(table.fingerprint),
    index("idx_agent_lessons_active").on(table.active),
    index("idx_agent_lessons_created_at").on(table.createdAt),
  ]
);

export type AgentLesson = typeof agentLessons.$inferSelect;
export type InsertAgentLesson = typeof agentLessons.$inferInsert;

/** Prompt/completion pairs for later model fine-tunes (OpenAI/Anthropic JSONL). */
export const agentFinetuneExamples = pgTable(
  "agent_finetune_examples",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: varchar("kind", { length: 32 }).notNull(), // revision | generation
    messages: jsonb("messages")
      .$type<{ role: string; content: string }[]>()
      .notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_finetune_examples_kind").on(table.kind),
    index("idx_agent_finetune_examples_created_at").on(table.createdAt),
  ]
);

export type AgentFinetuneExample = typeof agentFinetuneExamples.$inferSelect;
export type InsertAgentFinetuneExample = typeof agentFinetuneExamples.$inferInsert;

/** Oral board simulator: one row per saved chat session (OpenAI thread + UI "Session N"). */
export const oralBoardSessions = pgTable(
  "oral_board_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    openaiThreadId: varchar("openai_thread_id").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_oral_board_sessions_user_id").on(table.userId)]
);

export const oralBoardMessages = pgTable(
  "oral_board_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: varchar("session_id")
      .notNull()
      .references(() => oralBoardSessions.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_oral_board_messages_session_id").on(table.sessionId)]
);

export type OralBoardSession = typeof oralBoardSessions.$inferSelect;
export type InsertOralBoardSession = typeof oralBoardSessions.$inferInsert;
export type OralBoardMessage = typeof oralBoardMessages.$inferSelect;
export type InsertOralBoardMessage = typeof oralBoardMessages.$inferInsert;

/**
 * One-time cross-domain login handoff (prs-atlas.com ↔ ortho-atlas.com).
 * Cookies cannot span apex domains, so specialty switch / Ortho Stripe checkout
 * mints a short-lived token consumed on the target host to recreate the session.
 */
export const authHandoffTokens = pgTable(
  "auth_handoff_tokens",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    targetSpecialtyId: varchar("target_specialty_id", { length: 32 })
      .$type<SpecialtyId>()
      .notNull(),
    /** Relative path on the target origin after session is established (default `/`). */
    nextPath: varchar("next_path", { length: 512 }).notNull().default("/"),
    /** Optional allowlisted external URL (buy.stripe.com) to open after login. */
    continueExternalUrl: varchar("continue_external_url", { length: 1024 }),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("uidx_auth_handoff_tokens_hash").on(table.tokenHash),
    index("idx_auth_handoff_tokens_user_id").on(table.userId),
  ],
);

export type AuthHandoffToken = typeof authHandoffTokens.$inferSelect;
export type InsertAuthHandoffToken = typeof authHandoffTokens.$inferInsert;

/**
 * Remembers which plan a user just started checkout for so Stripe return can fulfill
 * even when sessionStorage was lost during a cross-domain handoff.
 */
export const pendingCheckoutPlans = pgTable("pending_checkout_plans", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: varchar("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: "cascade" }),
  specialtyId: varchar("specialty_id", { length: 32 })
    .$type<SpecialtyId>()
    .notNull()
    .default(DEFAULT_SPECIALTY_ID),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PendingCheckoutPlan = typeof pendingCheckoutPlans.$inferSelect;
export type InsertPendingCheckoutPlan = typeof pendingCheckoutPlans.$inferInsert;
