/**
 * The block vocabulary the document review panel renders.
 *
 * Previews are built in the main process by `artifactReview.ts` from the
 * artifact engine's own inspect outline, then handed to the renderer over IPC
 * as one of these snapshots. The panel renders blocks; it does not care which
 * format they came from.
 */

export type DocumentReviewBlockStyle =
  | "title"
  | "subtitle"
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bullet"
  | "numbered"
  | "quote"
  | "table";

export type DocumentReviewBlock = {
  id: string;
  style: DocumentReviewBlockStyle;
  text: string;
  cells?: string[][];
};

export type DocumentReviewSnapshot = {
  documentPath: string;
  title: string;
  blocks: DocumentReviewBlock[];
};
