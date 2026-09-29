/**
 * Heuristics for stems that promise media (photo, imaging, lab table) that may not be attached.
 * Used by the question-fix agent queue to surface candidates; a human or the agent makes the call.
 */
import { extractQuestionStem } from "./questionFormat";

export type MediaPromiseKind = "photo" | "imaging" | "labs";

export interface MediaPromise {
  kind: MediaPromiseKind;
  /** The text that triggered the match (for the agent and Slack). */
  match: string;
}

const PHOTO_NOUNS = "photograph|photographs|photo|photos|picture|pictures|clinical\\s+photograph|clinical\\s+image";
const IMAGING_NOUNS =
  "radiograph|radiographs|x-?rays?|ct(?:\\s+scan)?|mri|ultrasound|angiogram|angiography|panorex|panoramic|mammogram|imaging|scan|scans|film|films|image|images|figure";
const PROVIDE_VERBS = "shown|provided|presented|displayed|attached|depicted|illustrated|pictured";

const PHOTO_IS_SHOWN = new RegExp(
  `\\b(?:${PHOTO_NOUNS})\\b[^.?!\\n]{0,40}\\b(?:is|are|was|were)\\s+(?:${PROVIDE_VERBS})\\b`,
  "i"
);
const IMAGING_IS_SHOWN = new RegExp(
  `\\b(?:${IMAGING_NOUNS})\\b[^.?!\\n]{0,40}\\b(?:is|are|was|were)\\s+(?:${PROVIDE_VERBS})\\b`,
  "i"
);
const SHOWN_BELOW = new RegExp(`\\b(?:${PROVIDE_VERBS})\\s+(?:below|above|here)\\b`, "i");
const SEE_IMAGE = /\b(?:see|refer to)\s+(?:the\s+)?(?:image|figure|photograph|photo|picture|radiograph|x-?ray)\b/i;
const FOLLOWING_IMAGE = new RegExp(
  `\\b(?:following|accompanying|attached)\\s+(?:${PHOTO_NOUNS}|${IMAGING_NOUNS})\\b`,
  "i"
);
const LABS_PROMISE =
  /\b(?:lab(?:oratory)?\s+(?:values|results|findings|data|studies|tests?)|labs|laboratory\s+workup|blood\s+work)\b[^.?!\n]{0,60}\b(?:(?:are|is)\s+)?(?:shown|provided|below|as follows|listed|given|presented|attached)\b/i;
const FOLLOWING_LABS = /\bthe following (?:lab|laboratory)\b/i;

/** Digits appearing after the match position (lab tables carry values). */
function hasNumbersAfter(text: string, index: number): boolean {
  return /\d/.test(text.slice(index));
}

/**
 * Detect whether the stem promises media. `hasImage` short-circuits (media is attached).
 * Labs are only reported when no numeric values follow the promise phrase.
 */
export function detectMediaPromise(questionText: string, hasImage: boolean): MediaPromise | null {
  if (hasImage) return null;
  const stem = extractQuestionStem(questionText);
  if (!stem) return null;

  const labs = LABS_PROMISE.exec(stem) ?? FOLLOWING_LABS.exec(stem);
  if (labs && !hasNumbersAfter(stem, labs.index + labs[0].length)) {
    return { kind: "labs", match: labs[0] };
  }

  const photo = PHOTO_IS_SHOWN.exec(stem);
  if (photo) return { kind: "photo", match: photo[0] };

  const imaging = IMAGING_IS_SHOWN.exec(stem);
  if (imaging) return { kind: "imaging", match: imaging[0] };

  const generic = SHOWN_BELOW.exec(stem) ?? SEE_IMAGE.exec(stem) ?? FOLLOWING_IMAGE.exec(stem);
  if (generic) {
    const isPhoto = new RegExp(PHOTO_NOUNS, "i").test(stem);
    return { kind: isPhoto ? "photo" : "imaging", match: generic[0] };
  }
  return null;
}
