import type { QuestionAgentProposal } from "@shared/schema";
import { extractCorrectAnswer, extractMcqChoices, extractQuestionStem } from "@shared/questionFormat";

export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function questionHtml(question: string, answer: string): string {
  const stem = extractQuestionStem(question);
  const choices = extractMcqChoices(question);
  const key = extractCorrectAnswer(answer);
  const choiceRows = choices
    .map(
      (c) =>
        `<li class="${c.letter === key ? "key" : ""}"><strong>${escapeHtml(c.letter)})</strong> ${escapeHtml(c.text)}${
          c.letter === key ? " <em>(keyed answer)</em>" : ""
        }</li>`
    )
    .join("");
  return `<p class="stem">${escapeHtml(stem || question)}</p><ul>${choiceRows}</ul>
  <details><summary>Explanation</summary><pre>${escapeHtml(answer)}</pre></details>`;
}

const STYLE = `
  body{font:15px/1.5 system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#111}
  h1{font-size:20px} .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;background:#fafafa}
  .key{background:#e8f6ea} ul{padding-left:20px} pre{white-space:pre-wrap;background:#fff;padding:8px;border:1px solid #eee}
  .reasons{background:#fff6e5;border:1px solid #f0d9a8;border-radius:8px;padding:8px 16px}
  button{font-size:15px;padding:8px 18px;border-radius:6px;border:1px solid #888;cursor:pointer;margin-right:8px}
  .approve{background:#1a7f37;color:#fff;border-color:#1a7f37} .reject{background:#fff}
  img{max-width:100%;border:1px solid #ddd;border-radius:6px}
  @media(max-width:700px){.cols{grid-template-columns:1fr}}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderReviewPage(params: {
  proposal: QuestionAgentProposal;
  exp: number;
  sig: string;
  postPath: string;
  stale: boolean;
}): string {
  const { proposal: p } = params;
  const decided = p.status !== "pending";
  const changed = p.newQuestion != null && p.newAnswer != null;
  const a = p.imageAttribution;
  const image = p.imageUrl
    ? `<div class="card"><h2>Proposed image</h2><img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.imageAlt ?? "")}">
       <p>${escapeHtml(p.imageAlt ?? "")}</p>
       ${
         a
           ? `<p><small>Credit: ${escapeHtml(a.credit ?? "unknown")} | License: ${escapeHtml(a.license ?? "unknown")}${
               a.pmcid ? ` | ${escapeHtml(a.pmcid)}` : ""
             }${a.sourceUrl ? ` | <a href="${escapeHtml(a.sourceUrl)}" rel="noopener noreferrer">source</a>` : ""}</small></p>`
           : ""
       }</div>`
    : "";
  const actions = decided
    ? `<p><strong>This proposal is already ${escapeHtml(p.status)}.</strong></p>`
    : params.stale
      ? `<p><strong>The question was edited after this proposal was filed; it is stale and cannot be applied.</strong></p>`
      : `<form method="post" action="${escapeHtml(params.postPath)}">
           <input type="hidden" name="exp" value="${params.exp}">
           <input type="hidden" name="sig" value="${escapeHtml(params.sig)}">
           <button class="approve" name="action" value="approve" type="submit">Approve and apply</button>
           <button class="reject" name="action" value="reject" type="submit">Reject</button>
         </form>`;
  return shell(
    `Question agent proposal ${p.questionId}`,
    `<h1>Question agent proposal <code>${escapeHtml(p.questionId)}</code></h1>
     <div class="reasons"><strong>Needs approval because:</strong><ul>${p.reasons
       .map((r) => `<li>${escapeHtml(r)}</li>`)
       .join("")}${p.unhide ? "<li>Will unhide the question after applying.</li>" : ""}</ul></div>
     ${p.rationale ? `<p><strong>Agent rationale:</strong> ${escapeHtml(p.rationale)}</p>` : ""}
     <div class="cols">
       <div class="card"><h2>${changed ? "Before" : "Current"}</h2>${questionHtml(p.previousQuestion, p.previousAnswer)}</div>
       ${changed ? `<div class="card"><h2>After</h2>${questionHtml(p.newQuestion!, p.newAnswer!)}</div>` : ""}
     </div>
     ${image}
     <h2>Decision</h2>${actions}`
  );
}

export function renderMessagePage(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
