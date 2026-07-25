import React, { useMemo } from "react";

import type { DocumentReviewBlock, DocumentReviewSnapshot } from "../../shared/documentReview";
import { segmentDocumentReview, type DocumentReviewSentence } from "./documentReviewSelection";

function BlockText({
  block,
  sentences,
  commenting,
  selected,
  onToggleSentence,
}: {
  block: DocumentReviewBlock;
  sentences: DocumentReviewSentence[];
  commenting: boolean;
  selected: ReadonlySet<string>;
  onToggleSentence(id: string): void;
}) {
  const content = sentences.map((sentence, index) => {
    const isSelected = selected.has(sentence.id);
    const text = <>{sentence.text}{index < sentences.length - 1 ? " " : ""}</>;
    return commenting ? (
      <button
        className={`documentReviewSentence ${isSelected ? "isSelected" : ""}`}
        type="button"
        aria-pressed={isSelected}
        title={`${isSelected ? "Remove" : "Select"} sentence ${sentence.sentenceIndex + 1} in paragraph ${sentence.blockIndex + 1}`}
        onClick={() => onToggleSentence(sentence.id)}
        key={sentence.id}
      >
        {text}
      </button>
    ) : <React.Fragment key={sentence.id}>{text}</React.Fragment>;
  });
  if (block.style === "title") return <h1>{content}</h1>;
  if (block.style === "subtitle") return <p className="documentReviewSubtitle">{content}</p>;
  if (block.style === "heading1") return <h2>{content}</h2>;
  if (block.style === "heading2") return <h3>{content}</h3>;
  if (block.style === "heading3") return <h4>{content}</h4>;
  if (block.style === "quote") return <blockquote>{content}</blockquote>;
  return <p>{content}</p>;
}

export function DocumentReviewPreview({
  preview,
  commenting,
  selection,
  editor,
  onSelectionChange,
}: {
  preview: DocumentReviewSnapshot;
  commenting: boolean;
  selection: readonly string[];
  editor: React.ReactNode;
  onSelectionChange(selection: string[]): void;
}) {
  const sentences = useMemo(() => segmentDocumentReview(preview), [preview]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const byBlock = useMemo(() => {
    const grouped = new Map<string, DocumentReviewSentence[]>();
    for (const sentence of sentences) {
      const current = grouped.get(sentence.blockId) ?? [];
      current.push(sentence);
      grouped.set(sentence.blockId, current);
    }
    return grouped;
  }, [sentences]);
  const selectedBlockIndexes = sentences
    .filter((sentence) => selected.has(sentence.id))
    .map((sentence) => sentence.blockIndex);
  const editorBlockIndex = selectedBlockIndexes.length ? Math.max(...selectedBlockIndexes) : -1;
  const toggleSentence = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange([...next]);
  };
  const toggleBlock = (blockId: string) => {
    const blockSentences = byBlock.get(blockId) ?? [];
    const next = new Set(selected);
    const remove = blockSentences.every((sentence) => next.has(sentence.id));
    for (const sentence of blockSentences) {
      if (remove) next.delete(sentence.id);
      else next.add(sentence.id);
    }
    onSelectionChange([...next]);
  };

  return (
    <article className={`documentReviewPreview ${commenting ? "isCommenting" : ""}`} aria-label={`${preview.title} document preview`}>
      <div className="documentReviewPaper">
        {preview.blocks.map((block, blockIndex) => {
          const blockSentences = byBlock.get(block.id) ?? [];
          const selectedCount = blockSentences.filter((sentence) => selected.has(sentence.id)).length;
          return (
            <React.Fragment key={block.id}>
              <section
                className={`documentReviewBlock style-${block.style} ${selectedCount ? "hasSelection" : ""}`}
              >
                <button
                  className="documentReviewParagraphGutter"
                  type="button"
                  disabled={!commenting}
                  aria-pressed={selectedCount === blockSentences.length && blockSentences.length > 0}
                  aria-label={`${selectedCount === blockSentences.length ? "Remove" : "Select"} paragraph ${blockIndex + 1}`}
                  title={commenting ? `Select paragraph ${blockIndex + 1} for feedback` : undefined}
                  onClick={() => toggleBlock(block.id)}
                >
                  {blockIndex + 1}
                </button>
                <div className="documentReviewBlockContent">
                  {block.style === "bullet" || block.style === "numbered" ? (
                    <div className={`documentReviewListItem ${block.style}`}>
                      <span aria-hidden="true">{block.style === "bullet" ? "•" : `${blockIndex + 1}.`}</span>
                      <BlockText block={block} sentences={blockSentences} commenting={commenting} selected={selected} onToggleSentence={toggleSentence} />
                    </div>
                  ) : (
                    <BlockText block={block} sentences={blockSentences} commenting={commenting} selected={selected} onToggleSentence={toggleSentence} />
                  )}
                </div>
              </section>
              {editorBlockIndex === blockIndex ? editor : null}
            </React.Fragment>
          );
        })}
      </div>
    </article>
  );
}
