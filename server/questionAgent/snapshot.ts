/** Helpers for validating and diffing production content snapshots. */
import type { SpecialtyId } from "@shared/specialties";
import {
  CONTENT_FILE_FORMAT,
  computeContentHash,
  type SpecialtyContentFile,
} from "../content/specialtyContent";

export interface ContentDiff {
  added: number;
  removed: number;
  textChanged: number;
  visibilityChanged: number;
  imageChanged: number;
}

export function diffContent(before: SpecialtyContentFile | null, after: SpecialtyContentFile): ContentDiff {
  const diff: ContentDiff = { added: 0, removed: 0, textChanged: 0, visibilityChanged: 0, imageChanged: 0 };
  const prev = new Map((before?.questions ?? []).map((q) => [q.id, q]));
  const next = new Map(after.questions.map((q) => [q.id, q]));
  for (const [id, q] of next) {
    const p = prev.get(id);
    if (!p) {
      diff.added++;
      continue;
    }
    if (p.question !== q.question || p.answer !== q.answer) diff.textChanged++;
    if (p.visible !== q.visible || p.flagged !== q.flagged) diff.visibilityChanged++;
    if ((p.imageUrl ?? null) !== (q.imageUrl ?? null)) diff.imageChanged++;
  }
  for (const id of prev.keys()) if (!next.has(id)) diff.removed++;
  return diff;
}

export function validateSnapshot(file: SpecialtyContentFile, specialtyId: SpecialtyId): string[] {
  const errors: string[] = [];
  if (file.formatVersion !== CONTENT_FILE_FORMAT) errors.push(`unexpected format version ${file.formatVersion}`);
  if (file.specialtyId !== specialtyId) errors.push(`snapshot is for "${file.specialtyId}", expected "${specialtyId}"`);
  if (file.questions.length === 0) errors.push("snapshot has no questions");
  const recomputed = computeContentHash({
    sections: file.sections,
    subsections: file.subsections,
    questions: file.questions,
  });
  if (recomputed !== file.contentHash) errors.push("content hash does not match the payload (corrupted download?)");
  return errors;
}
