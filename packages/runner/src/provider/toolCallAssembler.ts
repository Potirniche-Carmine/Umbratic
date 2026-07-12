import type { ProviderStreamResult } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
}

export function reasoningContent(record: Record<string, unknown>): string {
  return textContent(record.reasoning_content) || textContent(record.reasoning) || textContent(record.thinking);
}

export function appendOpenAIToolDelta(acc: ProviderStreamResult, delta: Record<string, unknown>) {
  const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const raw of calls) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === "number" ? raw.index : 0;
    const fn = isRecord(raw.function) ? raw.function : {};
    const existing = acc.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
    acc.toolCalls.set(index, {
      id: typeof raw.id === "string" ? raw.id : existing.id,
      name: typeof fn.name === "string" ? fn.name : existing.name,
      arguments: existing.arguments + (typeof fn.arguments === "string" ? fn.arguments : ""),
    });
  }
}

export function appendOllamaToolCalls(acc: ProviderStreamResult, calls: unknown) {
  if (!Array.isArray(calls)) return;
  for (const raw of calls) {
    if (!isRecord(raw)) continue;
    const fn = isRecord(raw.function) ? raw.function : raw;
    const name = typeof fn.name === "string" ? fn.name : "";
    const args = typeof fn.arguments === "string" ? fn.arguments : isRecord(fn.arguments) ? JSON.stringify(fn.arguments) : "{}";
    const index = acc.toolCalls.size;
    acc.toolCalls.set(index, { id: typeof raw.id === "string" ? raw.id : "", name, arguments: args });
  }
}

export function invalidateTruncatedToolArguments(acc: ProviderStreamResult) {
  acc.truncatedToolArguments = true;
  for (const [index, call] of acc.toolCalls) acc.toolCalls.set(index, { ...call, arguments: "{\"__umbratic_truncated_tool_arguments__\":" });
}
