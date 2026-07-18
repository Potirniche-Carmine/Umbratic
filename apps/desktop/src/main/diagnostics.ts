import type { BackendUiEvent } from "./types";
import { redactText, shortHashValue } from "./policy";
import { appendLocalDiagnostic, type LocalDiagnosticInput } from "./storage";

const sensitiveKey = /(?:authorization|cookie|credential|api[_-]?key|secret|token|password)/i;
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export function sanitizeDiagnosticValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[depth-limited]";
  if (sensitiveKey.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if ((key === "cwd" || /(?:path|directory)$/i.test(key)) && absolutePath.test(value)) {
      return { pathHash: shortHashValue(value) };
    }
    return redactText(value, 8000);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 200)
        .map(([entryKey, entryValue]) => [entryKey, sanitizeDiagnosticValue(entryValue, entryKey, depth + 1)]),
    );
  }
  return String(value);
}

function eventLevel(event: BackendUiEvent): LocalDiagnosticInput["level"] {
  if (event.type === "task.error" || event.type === "tool.failed") return "error";
  if (
    (event.type === "command.finished" && (event.exitCode !== 0 || (event.status && event.status !== "success"))) ||
    (event.type === "permission.resolved" && event.decision === "deny") ||
    (event.type === "approval.check" && event.status === "failed")
  ) {
    return "warn";
  }
  return "info";
}

function eventMessage(event: BackendUiEvent): string | undefined {
  if (event.type === "task.error") return event.message;
  if (event.type === "command.finished") return event.errorMessage;
  if (event.type === "tool.failed") return event.response.errorMessage;
  if (event.type === "approval.check") return event.detail;
  return undefined;
}

export function localDiagnosticForBackendEvent(event: BackendUiEvent): LocalDiagnosticInput | null {
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta" || event.type === "user.message") {
    return null;
  }
  const { type, taskId, at, version: _version, ...data } = event;
  return {
    at,
    level: eventLevel(event),
    source: "desktop",
    event: type,
    taskId,
    message: eventMessage(event),
    data: sanitizeDiagnosticValue(data),
  };
}

export function recordLocalDiagnostic(input: LocalDiagnosticInput): void {
  try {
    appendLocalDiagnostic({ ...input, data: sanitizeDiagnosticValue(input.data) });
  } catch {
    // Diagnostics must never interrupt the product path they are observing.
  }
}

export function recordBackendEventDiagnostic(event: BackendUiEvent): void {
  const diagnostic = localDiagnosticForBackendEvent(event);
  if (diagnostic) recordLocalDiagnostic(diagnostic);
}
