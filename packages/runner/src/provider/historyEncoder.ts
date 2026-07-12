import type { ChatMessage } from "../session.js";
import { isApprovedVeilChatUrl } from "./local.js";
import type { ProviderCapabilities } from "./types.js";

export function isOllamaChatUrl(url: string): boolean {
  try { return /\/api\/chat\/?$/i.test(new URL(url).pathname); } catch { return false; }
}

export function isVeilChatUrl(url: string): boolean {
  return isApprovedVeilChatUrl(url);
}

export function providerCapabilities(url: string): ProviderCapabilities {
  if (isOllamaChatUrl(url)) return { structuredToolHistory: false, parallelToolCalls: false, streamedToolArguments: false, schemaProfile: "ollama" };
  if (isVeilChatUrl(url)) return { structuredToolHistory: false, parallelToolCalls: false, streamedToolArguments: true, schemaProfile: "veil-compatible" };
  return { structuredToolHistory: true, parallelToolCalls: true, streamedToolArguments: true, schemaProfile: "openai" };
}

function textContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n\n");
}

export function encodeProviderMessages(messages: ChatMessage[], capabilities: ProviderCapabilities) {
  const filtered = capabilities.schemaProfile === "veil-compatible" ? messages.filter((message) => message.role !== "system") : messages;
  if (capabilities.schemaProfile !== "ollama") return filtered;
  return filtered.map((message) => ({
    role: message.role,
    content: textContent(message.content),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
}
