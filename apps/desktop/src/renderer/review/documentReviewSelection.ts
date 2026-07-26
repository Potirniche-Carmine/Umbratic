import type { DocumentReviewBlock, DocumentReviewSnapshot } from "../../shared/documentReview";

export type DocumentReviewSentence = {
  id: string;
  blockId: string;
  blockIndex: number;
  sentenceIndex: number;
  text: string;
};

export type DocumentReviewSelectionDetails = {
  blockIds: string[];
  sentenceIds: string[];
  label: string;
  excerpt: string;
};

function fallbackSentences(value: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!".!?".includes(value[index])) continue;
    let end = index + 1;
    while (end < value.length && "\"'”’)]}".includes(value[end])) end += 1;
    if (end < value.length && !/\s/u.test(value[end])) continue;
    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    while (end < value.length && /\s/u.test(value[end])) end += 1;
    start = end;
    index = end - 1;
  }
  const remainder = value.slice(start).trim();
  if (remainder) sentences.push(remainder);
  return sentences.length ? sentences : [value];
}

function sentencesForBlock(block: DocumentReviewBlock): string[] {
  if (block.style === "title" || block.style.startsWith("heading")) return [block.text];
  if (typeof Intl.Segmenter === "function") {
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(block.text),
      (segment) => segment.segment.trim(),
    ).filter(Boolean);
    if (segments.length) return segments;
  }
  return fallbackSentences(block.text);
}

export function segmentDocumentReview(preview: DocumentReviewSnapshot): DocumentReviewSentence[] {
  return preview.blocks.flatMap((block, blockIndex) =>
    sentencesForBlock(block).map((text, sentenceIndex) => ({
      id: `${block.id}:sentence:${sentenceIndex + 1}`,
      blockId: block.id,
      blockIndex,
      sentenceIndex,
      text,
    })),
  );
}

export function documentReviewSelectionDetails(
  preview: DocumentReviewSnapshot,
  selectedIds: readonly string[],
): DocumentReviewSelectionDetails | null {
  const selected = new Set(selectedIds);
  const segments = segmentDocumentReview(preview);
  const chosen = segments.filter((segment) => selected.has(segment.id));
  if (!chosen.length) return null;
  const blockIndexes = [...new Set(chosen.map((segment) => segment.blockIndex))];
  const blockIds = blockIndexes.map((index) => preview.blocks[index].id);
  return {
    blockIds,
    sentenceIds: chosen.map((segment) => segment.id),
    label: "Selected text",
    excerpt: chosen.map((segment) => segment.text).join(" ").slice(0, 240),
  };
}
