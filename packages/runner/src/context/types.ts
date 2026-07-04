export type ContextContentKind =
  | "search"
  | "directory"
  | "file"
  | "command"
  | "json"
  | "log"
  | "diff"
  | "plain_text";

export type ContextCompressionStrategy =
  | "passthrough"
  | "search_top_lines"
  | "directory_grouped"
  | "log_errors_tail"
  | "json_array_sample"
  | "text_head_tail"
  | "tool_history_summary";

export type ContextCompressionResult = {
  output: string;
  modified: boolean;
  strategy: ContextCompressionStrategy;
  kind: ContextContentKind;
  originalBytes: number;
  outputBytes: number;
  markerHash?: string;
  reason?: string;
};

export const contextCompressionLimits = {
  minCompressBytes: 16 * 1024,
  maxDisplayedOutputBytes: 12 * 1024,
  maxStoredOriginalBytes: 512 * 1024,
  maxEntriesPerSession: 32,
  ttlMs: 4 * 60 * 60 * 1000,
  retrievalDefaultBytes: 12 * 1024,
  retrievalMaxBytes: 24 * 1024,
  searchPathHits: 60,
  searchContentHits: 80,
  directorySampleEntries: 120,
  logHeadLines: 40,
  logTailLines: 80,
  logImportantLines: 160,
  textHeadLines: 120,
  textTailLines: 80,
  jsonEdgeItems: 4,
  jsonErrorItems: 12,
} as const;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function clipUtf8Bytes(value: string, byteLimit: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= byteLimit) return value;
  return buffer.subarray(0, Math.max(0, byteLimit)).toString("utf8").replace(/^\uFFFD|\uFFFD$/gu, "");
}
