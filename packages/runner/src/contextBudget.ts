import type { ChatMessage } from "./session.js";
import type { ModelToolSpec } from "./tools/types.js";

export const DEFAULT_CONTEXT_LENGTH = 64_000;
export const DEFAULT_MAX_RESPONSE_TOKENS = 4_096;
export const DEFAULT_PROTECTED_PROMPT_RESERVE_TOKENS = 4_096;
export const MESSAGE_OVERHEAD_TOKENS = 10;
export const IMAGE_TOKENS = 1_600;

export type ContextBudgetOptions = {
  contextLength?: number;
  maxResponseTokens?: number;
  protectedPromptReserveTokens?: number;
  additionalPayloads?: readonly unknown[];
};

export type ContextUsageSnapshot = {
  contextLength: number;
  contentTokens: number;
  reserveTokens: number;
  estimatedTokens: number;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function estimateTextTokens(value: string | undefined | null): number {
  return value ? Math.ceil(value.length / 4) : 0;
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  if (typeof message.content === "string") {
    tokens += estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      tokens += part.type === "image_url" ? IMAGE_TOKENS : estimateTextTokens(part.text);
    }
  }
  if (message.tool_calls?.length) tokens += estimateTextTokens(JSON.stringify(message.tool_calls));
  if (message.tool_call_id) tokens += estimateTextTokens(message.tool_call_id);
  return tokens;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateToolSchemaTokens(tools: readonly ModelToolSpec[]): number {
  return tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0;
}

export function estimateSerializedTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return estimateTextTokens(serialized);
}

export function estimateContextUsage(
  messages: readonly ChatMessage[],
  tools: readonly ModelToolSpec[],
  options: ContextBudgetOptions = {},
): ContextUsageSnapshot {
  const contextLength = positiveInteger(options.contextLength, DEFAULT_CONTEXT_LENGTH);
  const maxResponseTokens = positiveInteger(options.maxResponseTokens, DEFAULT_MAX_RESPONSE_TOKENS);
  const protectedPromptReserveTokens = positiveInteger(
    options.protectedPromptReserveTokens,
    DEFAULT_PROTECTED_PROMPT_RESERVE_TOKENS,
  );
  const responseReserve = Math.min(maxResponseTokens, Math.floor(contextLength * 0.25));
  const protectedReserve = Math.min(protectedPromptReserveTokens, Math.floor(contextLength * 0.25));
  const contentTokens = estimateMessagesTokens(messages)
    + estimateToolSchemaTokens(tools)
    + (options.additionalPayloads ?? []).reduce<number>((total, payload) => total + estimateSerializedTokens(payload), 0);
  const reserveTokens = responseReserve + protectedReserve;
  return {
    contextLength,
    contentTokens,
    reserveTokens,
    estimatedTokens: contentTokens + reserveTokens,
  };
}
