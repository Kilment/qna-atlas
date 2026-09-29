/**
 * Tier rules for the question-fix cloud agent.
 *
 * A proposed fix is either:
 *  - "auto": safe to apply immediately (typos, formatting, explanation wording, removing a
 *    "photograph is shown" style phrase, choice wording that keeps the same meaning and key), or
 *  - "proposal": needs human approval (answer key change, choice meaning change, stem rewrite,
 *    unhiding, any image attach or replace).
 *
 * Pure functions only, so the same logic can be unit tested and reused by scripts.
 */
import {
  extractCorrectAnswer,
  extractMcqChoices,
  extractQuestionStem,
} from "./questionFormat";

export type FixTier = "auto" | "proposal";

export interface FixInput {
  previousQuestion: string;
  previousAnswer: string;
  nextQuestion: string;
  nextAnswer: string;
  /** Agent wants to attach or replace an image. */
  hasImageChange?: boolean;
  /** Agent wants to unflag / make a hidden question visible again. */
  wantsUnhide?: boolean;
  /** Agent wants to detach the current image (it does not match the question). */
  wantsRemoveImage?: boolean;
  /** Agent wants to flag and hide the question. */
  wantsHide?: boolean;
}

export interface FixClassification {
  tier: FixTier;
  /** True when nothing changed in question/answer text. */
  unchanged: boolean;
  /** Why this needs review (empty when tier is auto). */
  reasons: string[];
  /** What kind of edits the auto tier covers (for audit and Slack digests). */
  autoChanges: string[];
}

/** Words whose presence flips meaning; the multiset must stay identical for a change to be cosmetic. */
const MEANING_TOKENS = new Set([
  "no", "not", "non", "never", "without", "none", "neither", "nor", "cannot", "unable",
  "increase", "increased", "increases", "decrease", "decreased", "decreases",
  "high", "higher", "low", "lower", "more", "less", "most", "least", "largest", "smallest",
  "anterior", "posterior", "medial", "lateral", "superior", "inferior", "proximal", "distal",
  "dorsal", "volar", "palmar", "plantar", "left", "right", "ulnar", "radial",
  "superficial", "deep", "acute", "chronic", "early", "late", "before", "after",
  "only", "all", "any", "always", "first", "second", "third", "best", "worst",
  "positive", "negative", "benign", "malignant", "unilateral", "bilateral",
  // Patient demographics: changing who the patient is changes the clinical picture.
  "man", "men", "woman", "women", "male", "female", "boy", "girl", "he", "she", "his", "her", "him",
  "transgender", "pregnant", "infant", "neonate", "newborn", "child", "adolescent", "adult", "elderly",
]);

const MEDIA_PHRASE_RES: RegExp[] = [
  /\b(?:a|an|the)?\s*(?:clinical\s+)?(?:photograph|photo|picture|image|radiograph|x-?ray)s?\s+(?:is|are|was|were)\s+(?:shown|provided|presented|displayed|attached|depicted|illustrated)\b[.,;:]?/gi,
  /\b(?:shown|depicted|illustrated|pictured)\s+(?:below|above)\b[.,;:]?/gi,
  /\b(?:see|refer to)\s+(?:the\s+)?(?:image|figure|photograph|photo|picture)\s*(?:below|above)?\b[.,;:]?/gi,
];

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Lowercase, drop punctuation and spacing differences so cosmetic edits compare equal. */
export function normalizeForCompare(s: string): string {
  return collapse(
    (s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2018\u2019\u201b]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[^a-z0-9%.\s]/g, " ")
  );
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 = identical after normalization, 0 = completely different. */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  // Guard cost on very long text: length gap alone is decisive.
  if (maxLen > 6000 || Math.abs(na.length - nb.length) / maxLen > 0.3) {
    return Math.max(0, 1 - Math.abs(na.length - nb.length) / maxLen - 0.3);
  }
  return 1 - levenshtein(na, nb) / maxLen;
}

function numberTokens(s: string): string[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).sort();
}

function meaningTokens(s: string): string[] {
  return normalizeForCompare(s)
    .split(" ")
    .filter((t) => MEANING_TOKENS.has(t))
    .sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * True when two pieces of text differ only cosmetically: high similarity and identical numbers
 * and meaning-flipping words.
 */
export function isCosmeticEdit(before: string, after: string, minSimilarity = 0.9): boolean {
  if (normalizeForCompare(before) === normalizeForCompare(after)) return true;
  if (textSimilarity(before, after) < minSimilarity) return false;
  if (!sameList(numberTokens(before), numberTokens(after))) return false;
  if (!sameList(meaningTokens(before), meaningTokens(after))) return false;
  return onlyTypoWordChanges(before, after);
}

/** A replaced word counts as a typo fix only when it is long enough that a small edit cannot be another word. */
function isTypoPair(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  if (len < 7) return false;
  return levenshtein(a, b) <= (len >= 11 ? 2 : 1);
}

/**
 * Word-level guard on top of character similarity: in a long stem a single swapped word
 * ("cup" -> "prominent", "fascial" -> "myofascial", "woman" -> "man") barely moves the
 * similarity score, so every changed word must look like a typo fix, a split/joined word,
 * or a spelling of the same word.
 */
function onlyTypoWordChanges(before: string, after: string): boolean {
  const words = (t: string) =>
    normalizeForCompare(t)
      .split(" ")
      .map((w) => w.replace(/\.+$/, ""))
      .filter(Boolean);
  const a = words(before);
  const b = words(after);
  if (a.length * b.length > 4_000_000) return false;
  // Longest common subsequence table.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const groupOk = (): boolean => {
    if (removed.length === 0 && added.length === 0) return true;
    if (removed.join("") === added.join("")) return true; // words split or joined
    if (removed.length !== added.length) return false;
    return removed.every((w, k) => isTypoPair(w, added[k]));
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (!groupOk()) return false;
      removed = [];
      added = [];
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) {
      removed.push(a[i++]);
    } else {
      added.push(b[j++]);
    }
  }
  return groupOk();
}

/** Remove "a photograph is shown" style phrases. */
export function stripMediaPhrases(stem: string): string {
  let out = stem;
  for (const re of MEDIA_PHRASE_RES) out = out.replace(re, " ");
  return collapse(out);
}

/** True when the edit is exactly "delete a media-promise phrase" (plus cosmetic cleanup). */
export function isMediaPhraseRemoval(before: string, after: string): boolean {
  const stripped = stripMediaPhrases(before);
  if (stripped === collapse(before)) return false; // nothing to strip
  return isCosmeticEdit(stripped, after, 0.97) || normalizeForCompare(stripped) === normalizeForCompare(after);
}

function correctChoiceText(question: string, answer: string): { letter: string | null; text: string | null } {
  const letter = extractCorrectAnswer(answer);
  const choice = letter ? extractMcqChoices(question).find((c) => c.letter === letter) : undefined;
  return { letter, text: choice?.text ?? null };
}

export function classifyQuestionFix(input: FixInput): FixClassification {
  const reasons: string[] = [];
  const autoChanges: string[] = [];

  const prevQ = input.previousQuestion ?? "";
  const nextQ = input.nextQuestion ?? "";
  const prevA = input.previousAnswer ?? "";
  const nextA = input.nextAnswer ?? "";

  const unchanged = prevQ.trim() === nextQ.trim() && prevA.trim() === nextA.trim();

  if (input.hasImageChange) reasons.push("Attaches or replaces an image (image changes always need approval).");
  if (input.wantsUnhide) reasons.push("Unhides or unflags a question (needs approval).");
  if (input.wantsRemoveImage) reasons.push("Removes the current image (image changes always need approval).");
  if (input.wantsHide) reasons.push("Flags and hides the question (needs approval).");

  if (!unchanged) {
    const prevChoices = extractMcqChoices(prevQ);
    const nextChoices = extractMcqChoices(nextQ);

    if (prevChoices.length === 0 || nextChoices.length === 0) {
      reasons.push("Answer choices could not be parsed before or after the edit.");
    } else if (prevChoices.length !== nextChoices.length) {
      reasons.push(`Number of answer choices changed (${prevChoices.length} to ${nextChoices.length}).`);
    } else if (prevChoices.map((c) => c.letter).join("") !== nextChoices.map((c) => c.letter).join("")) {
      reasons.push("Answer choice letters changed.");
    }

    const prevKey = correctChoiceText(prevQ, prevA);
    const nextKey = correctChoiceText(nextQ, nextA);
    if (prevKey.letter !== nextKey.letter) {
      reasons.push(`Answer key changed (${prevKey.letter ?? "none"} to ${nextKey.letter ?? "none"}).`);
    }

    // Choice wording
    if (prevChoices.length > 0 && prevChoices.length === nextChoices.length) {
      let choiceEdited = false;
      let meaningChanged = false;
      prevChoices.forEach((pc, i) => {
        const nc = nextChoices[i];
        if (normalizeForCompare(pc.text) === normalizeForCompare(nc.text)) {
          if (pc.text.trim() !== nc.text.trim()) choiceEdited = true;
          return;
        }
        choiceEdited = true;
        const isKey = pc.letter === prevKey.letter;
        if (!isCosmeticEdit(pc.text, nc.text, isKey ? 0.95 : 0.9)) {
          meaningChanged = true;
          reasons.push(
            `Choice ${pc.letter}${isKey ? " (the keyed answer)" : ""} wording changed beyond a typo fix.`
          );
        }
      });
      if (choiceEdited && !meaningChanged) autoChanges.push("choice_wording");
    }

    // Stem
    const prevStem = extractQuestionStem(prevQ);
    const nextStem = extractQuestionStem(nextQ);
    if (normalizeForCompare(prevStem) !== normalizeForCompare(nextStem)) {
      if (isMediaPhraseRemoval(prevStem, nextStem)) {
        autoChanges.push("stem_media_phrase_removed");
      } else if (isCosmeticEdit(prevStem, nextStem, 0.9)) {
        autoChanges.push("stem_typo_or_formatting");
      } else {
        reasons.push("Stem was rewritten beyond typo or formatting fixes (clinical facts may have changed).");
      }
    } else if (prevStem.trim() !== nextStem.trim()) {
      autoChanges.push("stem_formatting");
    }

    // Explanation
    if (prevA.trim() !== nextA.trim()) {
      const shrink = nextA.trim().length / Math.max(1, prevA.trim().length);
      if (nextA.trim().length < 40 || shrink < 0.3) {
        reasons.push("Explanation was shortened drastically.");
      } else if (prevKey.letter === nextKey.letter) {
        autoChanges.push("explanation");
      }
    }
  }

  return {
    tier: reasons.length === 0 ? "auto" : "proposal",
    unchanged,
    reasons,
    autoChanges: reasons.length === 0 ? autoChanges : [],
  };
}
