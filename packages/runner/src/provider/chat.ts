import { configuredProviderEndpointUrl } from "./local.js";
import { encodeProviderMessages, providerCapabilities } from "./historyEncoder.js";
import { streamOllamaChat } from "./ollamaChat.js";
import { streamOpenAIChat } from "./openaiChat.js";
import type { ProviderStreamInput, ProviderStreamResult } from "./types.js";

export async function streamProviderChat(input: ProviderStreamInput & { lastMessageIsToolContext: boolean }): Promise<ProviderStreamResult> {
  const provider = input.session.config.provider;
  const url = configuredProviderEndpointUrl(provider.baseURL, provider.chatEndpointPath);
  const capabilities = providerCapabilities(url);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.apiKey.trim()) headers.Authorization = `Bearer ${provider.apiKey}`;
  Object.assign(headers, provider.headers ?? {});
  const messages = encodeProviderMessages(input.messages, capabilities) as any;
  if (capabilities.schemaProfile === "ollama") return streamOllamaChat({ ...input, messages, url, headers });
  return streamOpenAIChat({ ...input, messages, url, headers, veil: capabilities.schemaProfile === "veil-compatible" });
}
