export type ArtifactKind = "pdf" | "docx" | "pptx" | "xlsx";
export type OcrInputKind = "image" | "pdf";

export function promptLooksLikeArtifactTask(prompt: string): boolean {
  return /\b(pdf|docx|word document|powerpoint|pptx|presentation|deck|slides?|xlsx|excel|spreadsheet|workbook|artifact|one[-\s]?pager|report|whitepaper|white paper)\b/i.test(prompt);
}

export function promptLooksLikeOcrTask(prompt: string): boolean {
  return /\b(ocr|optical character recognition|extract text|read text|text from (?:an? )?(?:image|screenshot|scan|scanned|pdf)|transcribe|scan(?:ned)? document|screenshot text|image text|what does this say|form fields?|source-grounded extraction)\b/i.test(prompt);
}

export function artifactKindsForPrompt(prompt: string): ArtifactKind[] {
  const text = prompt.toLowerCase();
  const kinds: ArtifactKind[] = [];
  if (/\b(pdf|one[-\s]?pager|report|whitepaper|white paper)\b/.test(text)) kinds.push("pdf");
  if (/\b(docx|word document|word|memo|proposal document)\b/.test(text)) kinds.push("docx");
  if (/\b(powerpoint|pptx|presentation|deck|slides?)\b/.test(text)) kinds.push("pptx");
  if (/\b(xlsx|excel|spreadsheet|workbook|worksheet)\b/.test(text)) kinds.push("xlsx");
  return kinds;
}
