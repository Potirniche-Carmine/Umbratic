import type { UmbraticRunnerEvent } from "../events.js";
import type { ChatMessage, Session } from "../session.js";
import type { ModelToolSpec } from "../tools/types.js";

export type ProviderCapabilities = {
  structuredToolHistory: boolean;
  parallelToolCalls: boolean;
  streamedToolArguments: boolean;
  schemaProfile: "openai" | "ollama" | "veil-compatible";
};

export type ProviderToolCall = { id: string; name: string; arguments: string };

export type ProviderStreamResult = {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ProviderToolCall>;
  emittedContent: boolean;
  emittedReasoning: boolean;
  actionRequirement: "" | "change" | "execute" | "inspect" | "change-and-execute";
  promptTokens?: number;
  completionTokens?: number;
  truncatedToolArguments?: boolean;
};

export type ProviderStreamInput = {
  session: Session;
  messages: ChatMessage[];
  tools: readonly ModelToolSpec[];
  includeTools: boolean;
  requireToolCall?: boolean;
  parallelToolCalls?: boolean;
  suppressOutput: boolean;
  actionRequirementKnown: boolean;
  guardToolAnnouncements: boolean;
  emit?: (event: UmbraticRunnerEvent) => void;
};
