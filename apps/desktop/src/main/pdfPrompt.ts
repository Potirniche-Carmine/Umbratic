import { attachmentTextExcerpt, estimateTextTokens } from "../shared/contextWindow";
import { pdfPromptRoute, type PdfInspection } from "./pdfInspector";

export type PdfImageRender<Part> = {
  pageCount: number;
  rendered: number;
  parts: Part[];
};

export type PdfPromptSection<Part> = {
  lines: string[];
  /** Image parts to append after the lines; null when none should be sent. */
  imageParts: Part[] | null;
};

function pushMarkdownExcerpt(lines: string[], markdown: string, textBudget: { remainingTokens: number }) {
  const excerpt = attachmentTextExcerpt(markdown, textBudget.remainingTokens);
  textBudget.remainingTokens = Math.max(0, textBudget.remainingTokens - estimateTextTokens(excerpt.text));
  if (!excerpt.text) {
    lines.push("(text extract omitted to preserve the active context window; the complete text remains available through the tool above)");
    return;
  }
  lines.push("```markdown");
  lines.push(excerpt.text);
  lines.push("```");
  if (excerpt.truncated) {
    lines.push("Initial context contains a bounded extract; the complete text remains available through the tool above.");
  }
}

/**
 * Classify-then-route prompt assembly for one PDF attachment: native Markdown
 * for confident text PDFs, text plus per-page images for mixed documents, and
 * the vision render path for scans, garbled text layers, low confidence, or a
 * failed inspection.
 */
export async function pdfAttachmentPromptSection<Part>(options: {
  inspect: () => Promise<PdfInspection | null>;
  renderImages: (pageNumbers?: number[]) => Promise<PdfImageRender<Part> | null>;
  fullAccessHint: string;
  pageLimit: number;
  textBudget: { remainingTokens: number };
}): Promise<PdfPromptSection<Part>> {
  const lines: string[] = [];
  const inspection = await options.inspect();
  const route = pdfPromptRoute(inspection, options.pageLimit);
  const markdown = inspection?.markdown?.trim() ? inspection.markdown : null;
  const pageWord = `${inspection?.pageCount ?? 0} page${inspection?.pageCount === 1 ? "" : "s"}`;
  if (route.mode === "text" && markdown && inspection) {
    lines.push(
      `PDF with a native text layer (${pageWord}); extracted text below, no page images attached.`,
      options.fullAccessHint,
    );
    pushMarkdownExcerpt(lines, markdown, options.textBudget);
    return { lines, imageParts: null };
  }
  if (route.mode === "mixed" && markdown && inspection) {
    const rendered = await options.renderImages(route.ocrPages);
    const plural = route.ocrPages.length !== 1;
    lines.push(
      `PDF with a partial text layer (${pageWord}); text extracted natively, while page${plural ? "s" : ""} ${route.ocrPages.join(", ")} lack${plural ? "" : "s"} a text layer and ${plural ? "are" : "is"} attached as image${plural ? "s" : ""}.`,
      options.fullAccessHint,
    );
    pushMarkdownExcerpt(lines, markdown, options.textBudget);
    if (rendered?.parts.length) {
      return { lines, imageParts: rendered.parts };
    }
    lines.push("(the pages without a text layer could not be rendered as images)");
    return { lines, imageParts: null };
  }
  // Vision fallback: scans, image documents, low-confidence or garbled text
  // layers, and failed or unavailable inspection.
  const rendered = await options.renderImages();
  if (!rendered) {
    lines.push("(PDF pages could not be rendered for image input; the file may be encrypted, too large, or unsupported)");
    return { lines, imageParts: null };
  }
  if (inspection?.pdfType === "scanned" || inspection?.pdfType === "image_based") {
    lines.push(`PDF has no machine-readable text layer (classified ${inspection.pdfType}).`);
  } else if (inspection?.hasEncodingIssues) {
    lines.push("PDF text layer shows encoding issues; pages are attached as images instead of unreliable text.");
  }
  lines.push(
    rendered.rendered < rendered.pageCount
      ? `PDF rendered as images for the vision model: first ${rendered.rendered} of ${rendered.pageCount} pages.`
      : `PDF rendered as images for the vision model: ${rendered.pageCount} page${rendered.pageCount === 1 ? "" : "s"}.`,
  );
  return { lines, imageParts: rendered.parts };
}
