export const documentReviewSchemaVersion = 1 as const;
export const documentReviewByteLimit = 1024 * 1024;
export const documentReviewBlockLimit = 1_000;
export const documentReviewTextLimit = 500_000;

export type DocumentReviewBlockStyle =
  | "title"
  | "subtitle"
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bullet"
  | "numbered"
  | "quote";

export type DocumentReviewBlock = {
  id: string;
  style: DocumentReviewBlockStyle;
  text: string;
};

export type DocumentReviewSnapshot = {
  schemaVersion: typeof documentReviewSchemaVersion;
  documentPath: string;
  title: string;
  blocks: DocumentReviewBlock[];
};

const blockStyles = new Set<DocumentReviewBlockStyle>([
  "title",
  "subtitle",
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet",
  "numbered",
  "quote",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains an unsupported field.`);
}

function normalizedReviewPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function isDocumentReviewArtifactPath(value: string): boolean {
  const normalized = normalizedReviewPath(value);
  return /^\.umbratic\/artifacts\/docx\/[^/]+\.docx$/i.test(normalized)
    && !normalized.includes("..");
}

export function documentReviewSidecarPath(documentPath: string): string | null {
  const normalized = normalizedReviewPath(documentPath);
  return isDocumentReviewArtifactPath(normalized) ? `${normalized}.review.json` : null;
}

export function isDocumentReviewSidecarPath(value: string): boolean {
  const normalized = normalizedReviewPath(value);
  return /^\.umbratic\/artifacts\/docx\/[^/]+\.docx\.review\.json$/i.test(normalized)
    && !normalized.includes("..");
}

function normalizedText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (value.length > limit) throw new Error(`${label} is too long.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]*\n[ \t]*/g, " ").trim();
}

export function parseDocumentReviewSnapshot(
  value: unknown,
  expectedDocumentPath?: string,
): DocumentReviewSnapshot {
  if (!isRecord(value)) throw new Error("Document review snapshot must be an object.");
  assertKnownKeys(value, ["schemaVersion", "documentPath", "title", "blocks"], "Document review snapshot");
  if (value.schemaVersion !== documentReviewSchemaVersion) {
    throw new Error("Document review snapshot version is unsupported.");
  }
  const documentPath = normalizedText(value.documentPath, "Document path", 320);
  if (!isDocumentReviewArtifactPath(documentPath)) {
    throw new Error("Document path is outside the supported artifact directory.");
  }
  if (
    expectedDocumentPath
    && normalizedReviewPath(expectedDocumentPath) !== documentPath
  ) {
    throw new Error("Document review snapshot does not match the selected document.");
  }
  const title = normalizedText(value.title, "Document title", 240);
  if (!title) throw new Error("Document title is required.");
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > documentReviewBlockLimit) {
    throw new Error("Document review blocks are missing or exceed the supported limit.");
  }
  const ids = new Set<string>();
  let textLength = 0;
  const blocks = value.blocks.map((candidate, index): DocumentReviewBlock => {
    if (!isRecord(candidate)) throw new Error(`Document block ${index + 1} must be an object.`);
    assertKnownKeys(candidate, ["id", "style", "text"], `Document block ${index + 1}`);
    const id = normalizedText(candidate.id, `Document block ${index + 1} id`, 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ids.has(id)) {
      throw new Error(`Document block ${index + 1} has an invalid or duplicate id.`);
    }
    ids.add(id);
    if (typeof candidate.style !== "string" || !blockStyles.has(candidate.style as DocumentReviewBlockStyle)) {
      throw new Error(`Document block ${index + 1} has an unsupported style.`);
    }
    const text = normalizedText(candidate.text, `Document block ${index + 1} text`, 20_000);
    if (!text) throw new Error(`Document block ${index + 1} is empty.`);
    textLength += text.length;
    if (textLength > documentReviewTextLimit) throw new Error("Document review text exceeds the supported limit.");
    return { id, style: candidate.style as DocumentReviewBlockStyle, text };
  });
  return { schemaVersion: documentReviewSchemaVersion, documentPath, title, blocks };
}
