import type { QuestionAgentProposal } from "@shared/schema";
import { escapeForSlack, postQuestionAgentSlack, slackFieldsFromQuestion, databaseLabelForSpecialty } from "../notifySupport";
import { buildReviewUrl } from "./auth";

function clip(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function renderQuestionBlock(question: string, answer: string, indent = ""): string[] {
  const f = slackFieldsFromQuestion(question, answer);
  const lines: string[] = [];
  if (f.stem) lines.push(`${indent}*Stem:* ${escapeForSlack(clip(f.stem, 1200))}`);
  for (const c of f.choices) lines.push(`${indent}${escapeForSlack(`${c.letter}) ${clip(c.text, 300)}`)}`);
  if (f.correctAnswer) lines.push(`${indent}*Correct answer:* ${escapeForSlack(clip(f.correctAnswer, 300))}`);
  return lines;
}

export function formatProposalForSlack(
  proposal: QuestionAgentProposal,
  specialtyId: string | undefined,
  reviewUrl: string | null
): string {
  const lines: string[] = [
    `*Question agent proposal* \`${escapeForSlack(proposal.questionId)}\``,
    `Database: ${databaseLabelForSpecialty(specialtyId === "ortho" || specialtyId === "prs" ? specialtyId : undefined)}`,
    "",
    "*Needs your approval because:*",
    ...proposal.reasons.map((r) => `• ${escapeForSlack(r)}`),
  ];
  if (proposal.unhide) lines.push("• Will unhide the question after applying.");
  if (proposal.removeImage) lines.push("• Will remove the current image and its attribution after applying.");
  if (proposal.hide) lines.push("• Will flag and hide the question after applying."); 
  if (proposal.rationale) lines.push("", `*Agent rationale:* ${escapeForSlack(clip(proposal.rationale, 900))}`);

  if (proposal.newQuestion != null && proposal.newAnswer != null) {
    lines.push("", "*Before*", ...renderQuestionBlock(proposal.previousQuestion, proposal.previousAnswer));
    lines.push("", "*After*", ...renderQuestionBlock(proposal.newQuestion, proposal.newAnswer));
  } else {
    lines.push("", "*Current question*", ...renderQuestionBlock(proposal.previousQuestion, proposal.previousAnswer));
  }

  if (proposal.imageUrl) {
    const a = proposal.imageAttribution;
    lines.push(
      "",
      `*Image:* ${escapeForSlack(proposal.imageUrl)}${proposal.imageAlt ? ` (${escapeForSlack(proposal.imageAlt)})` : ""}`
    );
    if (a) {
      lines.push(
        `Credit: ${escapeForSlack(a.credit ?? "unknown")} | License: ${escapeForSlack(a.license ?? "unknown")}${
          a.pmcid ? ` | ${escapeForSlack(a.pmcid)}` : ""
        }${a.sourceUrl ? ` | ${escapeForSlack(a.sourceUrl)}` : ""}`
      );
    }
  }
  lines.push(
    "",
    reviewUrl
      ? `Review and approve or reject: ${reviewUrl}`
      : "Review link unavailable: set QUESTION_AGENT_APPROVAL_SECRET (and CANONICAL_PUBLIC_ORIGIN)."
  );
  return lines.join("\n");
}

/** Post a proposal to the question-agent Slack channel. Never throws. */
export async function notifyProposalSlack(
  proposal: QuestionAgentProposal,
  specialtyId?: string
): Promise<boolean> {
  try {
    const text = formatProposalForSlack(proposal, specialtyId, buildReviewUrl(proposal.id));
    return await postQuestionAgentSlack(text);
  } catch (err) {
    console.error("[questionAgent] Slack notify failed:", err);
    return false;
  }
}

/** Short Slack notice for each auto-applied fix (audit trail in the channel). */
export async function notifyAutoAppliedSlack(params: {
  questionId: string;
  specialtyId?: string;
  changes: string[];
  rationale?: string | null;
  revisionId: string;
  runId?: string | null;
}): Promise<boolean> {
  try {
    const lines = [
      `*Question agent auto-fixed* \`${escapeForSlack(params.questionId)}\``,
      `Database: ${databaseLabelForSpecialty(params.specialtyId === "ortho" || params.specialtyId === "prs" ? params.specialtyId : undefined)}`,
      `Changes: ${escapeForSlack(params.changes.join(", ") || "text")}`,
    ];
    if (params.rationale) lines.push(`Why: ${escapeForSlack(clip(params.rationale, 500))}`);
    lines.push(`Revision \`${escapeForSlack(params.revisionId)}\`${params.runId ? ` (run ${escapeForSlack(params.runId)})` : ""}`);
    return await postQuestionAgentSlack(lines.join("\n"));
  } catch (err) {
    console.error("[questionAgent] Slack notify failed:", err);
    return false;
  }
}
