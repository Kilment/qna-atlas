import { emailIsConfigured, sendEmail } from "./email";
import {
  extractCorrectAnswer,
  extractMcqChoices,
  extractQuestionStem,
} from "@shared/questionFormat";
import { getSpecialty, type SpecialtyId } from "@shared/specialties";
import { classifyPlanEvent } from "./notifyGrowthLogic";

export type SlackNotifyKind =
  | "question-report"
  | "support-form"
  | "user-signup"
  | "plan-purchase"
  | "question-agent";

export function databaseLabelForSpecialty(specialtyId?: SpecialtyId | null): string {
  if (specialtyId === "ortho") return "Ortho database";
  if (specialtyId === "prs") return "PRS database";
  return "Unknown";
}

/** Stem, choices, and keyed answer in the same shape Slack question-report messages use. */
export function slackFieldsFromQuestion(questionText: string, answerText: string): {
  stem: string | null;
  choices: { letter: string; text: string }[];
  correctAnswer: string | null;
} {
  const choices = extractMcqChoices(questionText);
  const correctLetter = extractCorrectAnswer(answerText);
  const correctChoice = correctLetter
    ? choices.find((c) => c.letter === correctLetter)
    : undefined;
  return {
    stem: extractQuestionStem(questionText) || null,
    choices,
    correctAnswer: correctLetter
      ? correctChoice
        ? `${correctLetter}) ${correctChoice.text}`
        : correctLetter
      : null,
  };
}

function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isSlackIncomingWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

function webhookUrlFor(kind: SlackNotifyKind): string | undefined {
  const fallback = process.env.SLACK_WEBHOOK_URL?.trim();
  const growthFallback = process.env.SLACK_GROWTH_WEBHOOK_URL?.trim() || fallback;
  const specific = {
    "question-report": process.env.SLACK_QUESTION_REPORTS_WEBHOOK_URL?.trim(),
    "question-agent":
      process.env.SLACK_QUESTION_AGENT_WEBHOOK_URL?.trim() ||
      process.env.SLACK_QUESTION_REPORTS_WEBHOOK_URL?.trim(),
    "support-form": process.env.SLACK_SUPPORT_WEBHOOK_URL?.trim(),
    "user-signup": process.env.SLACK_SIGNUPS_WEBHOOK_URL?.trim() || growthFallback,
    "plan-purchase": process.env.SLACK_PURCHASES_WEBHOOK_URL?.trim() || growthFallback,
  }[kind];
  const raw = specific || fallback;
  if (!raw) return undefined;
  if (!isSlackIncomingWebhook(raw)) {
    console.warn(`[Slack] Ignoring invalid webhook URL for ${kind} (expected https://hooks.slack.com/...)`);
    return undefined;
  }
  return raw;
}

/**
 * Incoming Webhook post. Never throws: support intake should still succeed if Slack is down.
 */
export async function postSlackNotification(
  kind: SlackNotifyKind,
  text: string
): Promise<boolean> {
  const url = webhookUrlFor(kind);
  if (!url) {
    console.warn(
      `[Slack] No webhook configured for ${kind} (set SLACK_WEBHOOK_URL or a channel-specific URL)`
    );
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Slack] Webhook ${kind} failed: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[Slack] Webhook ${kind} error:`, error);
    return false;
  }
}

/** Escape text for Slack mrkdwn (exported for the question-agent proposal messages). */
export function escapeForSlack(text: string): string {
  return slackEscape(text);
}

/** Post a pre-formatted message to the question-agent Slack channel. Never throws. */
export async function postQuestionAgentSlack(text: string): Promise<boolean> {
  return postSlackNotification("question-agent", text);
}

function clipForSlack(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function notifyQuestionReportSlack(params: {
  questionId: string;
  message: string;
  userEmail?: string | null;
  reportCount: number;
  autoHidden: boolean;
  databaseLabel?: string | null;
  stem?: string | null;
  choices?: { letter: string; text: string }[];
  correctAnswer?: string | null;
}): Promise<boolean> {
  const reporter = params.userEmail?.trim()
    ? slackEscape(params.userEmail.trim())
    : "(anonymous / not signed in)";
  const lines = [
    `*Question reported* \`${slackEscape(params.questionId)}\``,
    `Database: ${slackEscape(params.databaseLabel?.trim() || "Unknown")}`,
    `Reporter: ${reporter}`,
    `Total reports for this question: ${params.reportCount}${
      params.autoHidden ? " — auto-hidden" : ""
    }`,
  ];
  if (params.stem?.trim()) {
    lines.push("", "*Stem*", slackEscape(clipForSlack(params.stem, 1500)));
  }
  if (params.choices && params.choices.length > 0) {
    lines.push("", "*Answer choices*");
    for (const c of params.choices) {
      lines.push(
        slackEscape(`${c.letter}) ${clipForSlack(c.text, 400)}`)
      );
    }
  }
  if (params.correctAnswer?.trim()) {
    lines.push("", `*Correct answer:* ${slackEscape(clipForSlack(params.correctAnswer, 500))}`);
  }
  lines.push("", slackEscape(params.message.slice(0, 2000)));
  return postSlackNotification("question-report", lines.join("\n"));
}

export async function sendSupportContactEmail(params: {
  toEmail: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  message: string;
  specialtyLabel: string;
}): Promise<boolean> {
  if (!emailIsConfigured()) {
    console.warn("[Support form] RESEND_API_KEY is not set — no email will be sent.");
    return false;
  }

  const body = [
    `Support form submission (${params.specialtyLabel})`,
    "",
    `From: ${params.fromName} <${params.fromEmail}>`,
    `Subject: ${params.subject}`,
    "",
    params.message,
  ].join("\n");

  try {
    await sendEmail(
      {
        to: params.toEmail,
        replyTo: params.fromEmail,
        subject: `[Support] ${params.subject}`,
        text: body,
      },
      "Support form"
    );
    return true;
  } catch (error) {
    console.error("[Support form] Failed to send:", error);
    return false;
  }
}

export async function notifySupportFormSlack(params: {
  fromName: string;
  fromEmail: string;
  subject: string;
  message: string;
  specialtyLabel: string;
}): Promise<boolean> {
  const lines = [
    `*Support form* (${slackEscape(params.specialtyLabel)})`,
    `From: ${slackEscape(params.fromName)} <${slackEscape(params.fromEmail)}>`,
    `Subject: ${slackEscape(params.subject)}`,
    "",
    slackEscape(params.message.slice(0, 3000)),
  ];
  return postSlackNotification("support-form", lines.join("\n"));
}

const recentGrowthNotifyKeys = new Map<string, number>();
const GROWTH_NOTIFY_TTL_MS = 6 * 60 * 60 * 1000;

function claimGrowthNotifyKey(key: string | undefined): boolean {
  const normalized = key?.trim();
  if (!normalized) return true;
  const now = Date.now();
  for (const [existing, at] of recentGrowthNotifyKeys) {
    if (now - at > GROWTH_NOTIFY_TTL_MS) recentGrowthNotifyKeys.delete(existing);
  }
  if (recentGrowthNotifyKeys.has(normalized)) return false;
  recentGrowthNotifyKeys.set(normalized, now);
  return true;
}

function displayName(firstName?: string | null, lastName?: string | null): string {
  return [firstName, lastName].map((p) => p?.trim()).filter(Boolean).join(" ") || "Unknown name";
}

function formatUsdCents(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toFixed(2)}`;
}

/** Fire-and-forget Slack posts so auth/checkout never wait on Slack. */
export function scheduleSlackNotify(task: () => Promise<unknown>): void {
  void task().catch((error) => {
    console.error("[Slack] Background notify failed:", error);
  });
}

export async function notifyNewUserSlack(params: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  specialtyId?: SpecialtyId | null;
  trainingLevel?: string | null;
  institution?: string | null;
  source?: string | null;
}): Promise<boolean> {
  const specialty = params.specialtyId ? getSpecialty(params.specialtyId) : null;
  const lines = [
    `*New user registered* — ${slackEscape(displayName(params.firstName, params.lastName))}`,
    `Email: ${slackEscape(params.email)}`,
    `Specialty: ${slackEscape(specialty?.specialtyName || "Unknown")}`,
  ];
  if (params.trainingLevel?.trim()) {
    lines.push(`Training level: ${slackEscape(params.trainingLevel.trim())}`);
  }
  if (params.institution?.trim()) {
    lines.push(`Institution: ${slackEscape(params.institution.trim())}`);
  }
  if (params.source?.trim()) {
    lines.push(`Source: ${slackEscape(params.source.trim())}`);
  }
  return postSlackNotification("user-signup", lines.join("\n"));
}

export async function notifyPlanPurchaseSlack(params: {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  specialtyId: SpecialtyId;
  planName: string;
  previousPlanName?: string | null;
  previousStatus?: string | null;
  amountCents: number;
  durationMonths?: number | null;
  source?: string | null;
  idempotencyKey?: string | null;
}): Promise<boolean> {
  const key =
    params.idempotencyKey?.trim() ||
    `${params.email || "unknown"}:${params.specialtyId}:${params.planName}:${params.amountCents}`;
  if (!claimGrowthNotifyKey(key)) return false;

  const kind = classifyPlanEvent(
    params.previousPlanName,
    params.previousStatus,
    params.planName
  );
  const specialty = getSpecialty(params.specialtyId);
  const who = `${displayName(params.firstName, params.lastName)}${
    params.email?.trim() ? ` <${params.email.trim()}>` : ""
  }`;
  const headline =
    kind === "upgraded"
      ? `*Plan upgraded* — ${slackEscape(who)}`
      : `*Plan purchased* — ${slackEscape(who)}`;
  const lines = [
    headline,
    `Product: ${slackEscape(specialty.brandName)}`,
    kind === "upgraded"
      ? `Plan: ${slackEscape(params.previousPlanName || "unknown")} → ${slackEscape(params.planName)}`
      : `Plan: ${slackEscape(params.planName)}`,
    `Amount: ${formatUsdCents(params.amountCents)}`,
  ];
  if (params.durationMonths != null) {
    lines.push(`Duration: ${params.durationMonths} month${params.durationMonths === 1 ? "" : "s"}`);
  }
  if (params.source?.trim()) {
    lines.push(`Source: ${slackEscape(params.source.trim())}`);
  }
  return postSlackNotification("plan-purchase", lines.join("\n"));
}
