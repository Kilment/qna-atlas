/**
 * Shared two-model vision request. The rubric is identical across questions and is
 * cached for an hour. The question text is cached for 5 minutes so several figures
 * for one item reuse it. The image is always after those breakpoints.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { cachedSystem } from "../../claudePromptCache";

export const VISION_SYSTEM_PROMPT = `You are an independent visual reviewer for Atlas Review, a surgical board-exam question bank covering plastic surgery and orthopaedics. You are shown one figure and the question it might illustrate. Learners see the figure without the article caption, title, or credit line, so judge only the pixels together with the stem and keyed answer in the user message.

Accept the figure only when every check below passes. If you cannot tell, do not assume a match: set that match field to false and reject.

1. Body part. The anatomic site in the image is the site the stem is about. A hand cannot illustrate a foot finding. A knee cannot illustrate a hip. A finger cannot illustrate a wrist when the stem is specifically about the wrist. Reject a neighboring region even when the diagnosis family is related.

2. Laterality. When the stem says left or right, the image must show that side, or be a midline structure where side is not visible. An image labeled with the opposite side fails. When the stem does not state a side, do not reject for laterality; set lateralityMatch to true in that case.

3. Modality. A clinical photograph, radiograph, CT, MRI, ultrasound, angiogram, or intraoperative photo must match what the stem implies. If the stem says a photograph is shown, a radiograph fails. If the stem describes an x-ray, CT, or MRI finding, a clinical photo fails. When the stem does not imply a modality, accept the modality that depicts the described finding and set modalityMatch to true.

4. Age and sex. If the stem states an age group or sex and the image clearly contradicts it (infant versus adult, or an obviously different sex when the finding is sex-specific), reject. Do not guess sex or age from an image that does not show them; set ageSexMatch to true when the image does not contradict the stem.

5. Diagnosis leak. Reject when any visible text, burned-in caption, arrow label, measurement, watermark, or annotation names the diagnosis, the eponym, the keyed answer, or a choice letter. Generic scale bars and laterality markers with no diagnostic words are acceptable. The article title is not part of the image; do not treat it as a leak unless those words are printed on the figure.

6. Single clear view. Reject multi-panel figures, collages, contact sheets, and files that stack two views. Learners need one view. A single radiograph that contains two projections in one frame is multi-panel and fails.

7. Clinical match. The image must depict the finding the stem describes, at the stage the stem describes. Reject a post-treatment result when the stem is pre-treatment, an unrelated textbook plate, or a different condition in the same region.

Return JSON only, with no markdown fence:
{"pass": true or false, "bodyPartMatch": true or false, "lateralityMatch": true or false, "modalityMatch": true or false, "ageSexMatch": true or false, "visibleTextLeak": true or false, "multiPanel": true or false, "summary": "one sentence"}

Set pass to true only when bodyPartMatch, lateralityMatch, modalityMatch, and ageSexMatch are true, visibleTextLeak is false, and multiPanel is false. Otherwise set pass to false. summary is one sentence naming the decisive reason.`;

export function questionBlock(question: string, answer: string): Anthropic.TextBlockParam {
  return {
    type: "text",
    text: `QUESTION (stem and choices):\n${question}\n\nKEYED ANSWER AND EXPLANATION:\n${answer}`,
    cache_control: { type: "ephemeral" },
  };
}

export function buildVisionRequest(params: {
  model: string;
  question: string;
  answer: string;
  imageBase64: string;
  peerNotes?: string;
  maxTokens?: number;
}): Anthropic.MessageCreateParamsNonStreaming {
  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
    questionBlock(params.question, params.answer),
  ];
  const peer = params.peerNotes?.trim();
  if (peer) {
    content.push({
      type: "text",
      text: `Another reviewer already judged this same figure. Look at the pixels yourself, then account for their findings. If you still disagree, say so in summary.\n${peer}`,
    });
  }
  content.push({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: params.imageBase64 },
  });
  return {
    model: params.model,
    max_tokens: params.maxTokens ?? 500,
    system: cachedSystem(VISION_SYSTEM_PROMPT, "1h"),
    messages: [{ role: "user", content }],
  };
}
