import { contextHash } from "./sessionContextStore.js";
import { contextMarker, contextRetrievalInstruction } from "./markers.js";
import {
  clipUtf8Bytes,
  contextCompressionLimits,
  utf8ByteLength,
  type ContextCompressionResult,
  type ContextCompressionStrategy,
  type ContextContentKind,
} from "./types.js";
import type { SessionContextStore } from "./sessionContextStore.js";
import type { ToolResultStatus } from "../tools/common.js";

type CompressToolResultInput = {
  toolName: string;
  toolCallId: string;
  title: string;
  output: string;
  status: ToolResultStatus;
  contextStore: SessionContextStore;
};

function result(input: {
  output: string;
  modified: boolean;
  strategy: ContextCompressionStrategy;
  kind: ContextContentKind;
  originalBytes: number;
  markerHash?: string;
  reason?: string;
}): ContextCompressionResult {
  return {
    ...input,
    outputBytes: utf8ByteLength(input.output),
  };
}

function classifyKind(toolName: string, output: string): ContextContentKind {
  const trimmed = output.trimStart();
  if (toolName === "search") return "search";
  if (trimmed.startsWith("Directory:")) return "directory";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (toolName === "command") return "log";
  if (toolName === "read") return "file";
  if (/^diff --git\b/m.test(output)) return "diff";
  return "plain_text";
}

function jsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function outputLooksUnsafeToStore(output: string): boolean {
  return /refusing blocked path|workspace_boundary|blocked path/i.test(output) && !/\[redacted/i.test(output);
}

function fitBody(body: string): string {
  if (utf8ByteLength(body) <= contextCompressionLimits.maxDisplayedOutputBytes) return body;
  return `${clipUtf8Bytes(body, contextCompressionLimits.maxDisplayedOutputBytes)}\n...[compacted output clipped to display budget]`;
}

function appendStoredMarker(input: CompressToolResultInput, kind: ContextContentKind, strategy: ContextCompressionStrategy, body: string, reason?: string): ContextCompressionResult {
  const { hash } = contextHash(input.output);
  const marker = contextMarker({
    hash,
    kind,
    strategy,
    originalBytes: utf8ByteLength(input.output),
    shownBytes: utf8ByteLength(body),
    storedBytes: Math.min(utf8ByteLength(input.output), contextCompressionLimits.maxStoredOriginalBytes),
    capped: utf8ByteLength(input.output) > contextCompressionLimits.maxStoredOriginalBytes,
  });
  const output = [
    body,
    "",
    marker,
    contextRetrievalInstruction(hash),
  ].join("\n");
  const entry = input.contextStore.store({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    title: input.title,
    original: input.output,
    compressed: output,
    kind,
    strategy,
    originalBytes: utf8ByteLength(input.output),
    compressedBytes: utf8ByteLength(output),
  });
  return result({
    output,
    modified: true,
    strategy,
    kind,
    originalBytes: entry.originalBytes,
    markerHash: entry.hash,
    ...(reason ? { reason } : {}),
  });
}

function searchTopLines(output: string): string {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const pathHits = lines.filter((line) => /:\s*path$/i.test(line));
  const contentHits = lines.filter((line) => /:\d+:\s*content$/i.test(line));
  const otherHits = lines.filter((line) => !pathHits.includes(line) && !contentHits.includes(line));
  const shown = [
    "Search output compressed.",
    `Total hits: ${lines.length}`,
    "",
    "Path hits:",
    ...(pathHits.length ? pathHits.slice(0, contextCompressionLimits.searchPathHits) : ["(none)"]),
    "",
    "Content hits:",
    ...(contentHits.length ? contentHits.slice(0, contextCompressionLimits.searchContentHits) : ["(none)"]),
    ...(otherHits.length ? ["", "Other hits:", ...otherHits.slice(0, 40)] : []),
  ];
  return fitBody(shown.join("\n"));
}

function directoryGrouped(output: string): string {
  const lines = output.split(/\r?\n/);
  const entriesIndex = lines.findIndex((line) => line.trim() === "Entries:");
  if (entriesIndex === -1) return textHeadTail(output, "Directory output compressed.");

  const header = lines.slice(0, entriesIndex + 1);
  const entries = lines.slice(entriesIndex + 1).filter(Boolean);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const topLevel = entry.replace(/^\.\//, "").split("/")[0] || entry;
    counts.set(topLevel, (counts.get(topLevel) ?? 0) + 1);
  }
  const grouped = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 80)
    .map(([name, count]) => `- ${name}: ${count}`);

  return fitBody([
    "Directory listing compressed.",
    ...header,
    "",
    "Grouped entries:",
    ...(grouped.length ? grouped : ["(none)"]),
    "",
    `Entries sample (${Math.min(entries.length, contextCompressionLimits.directorySampleEntries)} of ${entries.length}):`,
    ...entries.slice(0, contextCompressionLimits.directorySampleEntries),
  ].join("\n"));
}

function numberedSection(title: string, rows: string[]): string[] {
  return rows.length ? [title, ...rows] : [title, "(none)"];
}

function logErrorsTail(output: string): string {
  const lines = output.split(/\r?\n/);
  const importantPattern = /exitCode=|error|fail|failed|failure|exception|panic|traceback|warning|warn|denied|timed out|timeout/i;
  const important = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => importantPattern.test(line))
    .slice(0, contextCompressionLimits.logImportantLines);
  const selected = new Map<number, string>();
  lines.slice(0, contextCompressionLimits.logHeadLines).forEach((line, index) => selected.set(index, line));
  important.forEach(({ line, index }) => selected.set(index, line));
  lines.slice(Math.max(0, lines.length - contextCompressionLimits.logTailLines)).forEach((line, tailIndex) => {
    selected.set(Math.max(0, lines.length - contextCompressionLimits.logTailLines) + tailIndex, line);
  });

  const repeated = new Map<string, number>();
  const rows: string[] = [];
  for (const [index, line] of [...selected.entries()].sort((left, right) => left[0] - right[0])) {
    const count = (repeated.get(line) ?? 0) + 1;
    repeated.set(line, count);
    if (count <= 3) {
      rows.push(`${index + 1}: ${line}`);
    } else if (count === 4) {
      rows.push(`${index + 1}: [repeated identical line omitted]`);
    }
  }

  return fitBody([
    "Command/log output compressed.",
    `Total lines: ${lines.length}`,
    "",
    ...numberedSection("Preserved lines:", rows),
  ].join("\n"));
}

function summarizeJsonValue(value: unknown): string {
  return clipUtf8Bytes(JSON.stringify(value, null, 2) ?? "null", 1400);
}

function objectHasErrorShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).some(([key, raw]) => {
    if (/error|fail|exception/i.test(key)) return true;
    if (/status|state/i.test(key) && typeof raw === "string" && !/success|ok|passed/i.test(raw)) return true;
    return false;
  });
}

function largestArray(value: unknown): { path: string; items: unknown[] } | null {
  if (Array.isArray(value)) return { path: "$", items: value };
  if (!value || typeof value !== "object") return null;
  let best: { path: string; items: unknown[] } | null = null;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(raw) && (!best || raw.length > best.items.length)) {
      best = { path: key, items: raw };
    }
  }
  return best;
}

function jsonArraySample(output: string): string | null {
  const parsed = jsonParse(output);
  if (parsed === null) return null;
  const target = largestArray(parsed);
  if (!target) {
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed as Record<string, unknown>) : [];
    return fitBody([
      "JSON output compressed.",
      ...(keys.length ? [`Top-level keys: ${keys.join(", ")}`] : []),
      summarizeJsonValue(parsed),
    ].join("\n"));
  }

  const first = target.items.slice(0, contextCompressionLimits.jsonEdgeItems);
  const last = target.items.slice(Math.max(contextCompressionLimits.jsonEdgeItems, target.items.length - contextCompressionLimits.jsonEdgeItems));
  const errors = target.items.filter(objectHasErrorShape).slice(0, contextCompressionLimits.jsonErrorItems);
  return fitBody([
    "JSON array output compressed.",
    `Array path: ${target.path}`,
    `Items: ${target.items.length}`,
    "",
    "First items:",
    ...first.map(summarizeJsonValue),
    "",
    "Error/status items:",
    ...(errors.length ? errors.map(summarizeJsonValue) : ["(none)"]),
    "",
    "Last items:",
    ...last.map(summarizeJsonValue),
  ].join("\n"));
}

function textHeadTail(output: string, intro = "Text output compressed."): string {
  const lines = output.split(/\r?\n/);
  const headingLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(?:#{1,6}\s+|\[[^\]]+\]|[A-Z][A-Za-z0-9 _/-]{0,80}:$)/.test(line.trim()))
    .slice(0, 40)
    .map(({ line, index }) => `${index + 1}: ${line}`);
  const head = lines.slice(0, contextCompressionLimits.textHeadLines).map((line, index) => `${index + 1}: ${line}`);
  const tailStart = Math.max(0, lines.length - contextCompressionLimits.textTailLines);
  const tail = lines.slice(tailStart).map((line, index) => `${tailStart + index + 1}: ${line}`);
  return fitBody([
    intro,
    `Total lines: ${lines.length}`,
    ...(headingLines.length ? ["", "Headings:", ...headingLines] : []),
    "",
    "Head:",
    ...head,
    "",
    "Tail:",
    ...tail,
  ].join("\n"));
}

export function compressToolResult(input: CompressToolResultInput): ContextCompressionResult {
  const originalBytes = utf8ByteLength(input.output);
  const kind = classifyKind(input.toolName, input.output);
  if (input.toolName === "retrieve_context" || originalBytes < contextCompressionLimits.minCompressBytes) {
    return result({
      output: input.output,
      modified: false,
      strategy: "passthrough",
      kind,
      originalBytes,
    });
  }

  if (outputLooksUnsafeToStore(input.output)) {
    return result({
      output: fitBody(input.output),
      modified: utf8ByteLength(input.output) > utf8ByteLength(fitBody(input.output)),
      strategy: "text_head_tail",
      kind,
      originalBytes,
      reason: "unsafe_to_store_raw_output",
    });
  }

  let strategy: ContextCompressionStrategy = "text_head_tail";
  let body: string | null = null;
  if (kind === "search") {
    strategy = "search_top_lines";
    body = searchTopLines(input.output);
  } else if (kind === "directory") {
    strategy = "directory_grouped";
    body = directoryGrouped(input.output);
  } else if (kind === "json") {
    strategy = "json_array_sample";
    body = jsonArraySample(input.output);
  } else if (kind === "log" || input.toolName === "command") {
    strategy = "log_errors_tail";
    body = logErrorsTail(input.output);
  }

  if (!body) {
    strategy = "text_head_tail";
    body = textHeadTail(input.output);
  }

  if (utf8ByteLength(body) >= originalBytes) {
    return result({
      output: input.output,
      modified: false,
      strategy: "passthrough",
      kind,
      originalBytes,
      reason: "compression_not_smaller",
    });
  }

  return appendStoredMarker(input, kind, strategy, body, input.status === "success" ? undefined : "status_not_success");
}
