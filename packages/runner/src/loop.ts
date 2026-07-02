import { nowIso, type UmbraticRunnerEvent } from "./events.js";
import type { ChatContentPart, ChatMessage, InputPart, Session } from "./session.js";
import { redactText } from "./policy.js";
import { enabledModelToolSpecs, runTool } from "./tools/index.js";
import { toolFailureDetails, type ToolContext, type ToolResultStatus } from "./tools/common.js";
import { modelHttpRequest, readBodyText } from "./provider/http.js";
import { configuredProviderEndpointUrl, isApprovedVeilChatUrl } from "./provider/local.js";

type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type StreamAccumulator = {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCall>;
  emittedContent: boolean;
  emittedReasoning: boolean;
};

type ToolContextResult = {
  call: ToolCall;
  title: string;
  output: string;
  status: ToolResultStatus;
};

const maxToolContextBytes = 56 * 1024;
const maxToolResultBytes = 24 * 1024;
const maxStructuredToolHistorySegments = 4;
const maxCompactedToolHistoryBytes = 12 * 1024;
const streamEventCoalesceIntervalMs = 40;
const maxCoalescedTextChars = 2048;

type CoalescibleRunnerEvent = Extract<
  UmbraticRunnerEvent,
  { type: "assistant.delta" | "assistant.reasoning.delta" | "tool.output" }
>;

function coalescibleEventKey(event: CoalescibleRunnerEvent): string {
  if (event.type === "tool.output") {
    return `${event.type}:${event.taskId}:${event.toolCallId}:${event.stream}`;
  }
  return `${event.type}:${event.taskId}`;
}

function isCoalescibleRunnerEvent(event: UmbraticRunnerEvent): event is CoalescibleRunnerEvent {
  return event.type === "assistant.delta" || event.type === "assistant.reasoning.delta" || event.type === "tool.output";
}

export function createRunnerEventCoalescer(
  emit: (event: UmbraticRunnerEvent) => void,
  options: { intervalMs?: number; maxTextChars?: number } = {},
): { emit(event: UmbraticRunnerEvent): void; flush(): void } {
  const intervalMs = options.intervalMs ?? streamEventCoalesceIntervalMs;
  const maxTextChars = options.maxTextChars ?? maxCoalescedTextChars;
  let pending: CoalescibleRunnerEvent | null = null;
  let pendingKey = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearFlushTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearFlushTimer();
    if (!pending) return;
    emit(pending);
    pending = null;
    pendingKey = "";
  };

  const scheduleFlush = () => {
    if (timer || intervalMs <= 0) return;
    timer = setTimeout(flush, intervalMs);
  };

  const coalescedEmit = (event: UmbraticRunnerEvent) => {
    if (!isCoalescibleRunnerEvent(event)) {
      flush();
      emit(event);
      return;
    }

    const key = coalescibleEventKey(event);
    if (pending && pendingKey === key && pending.text.length + event.text.length <= maxTextChars) {
      pending = {
        ...pending,
        text: `${pending.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? pending.endedAt ?? pending.at,
      };
      scheduleFlush();
      return;
    }

    flush();
    pending = event;
    pendingKey = key;
    scheduleFlush();
    if (pending.text.length >= maxTextChars) {
      flush();
    }
  };

  return { emit: coalescedEmit, flush };
}

function clipUtf8(value: string, byteLimit: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= byteLimit) return value;
  return buffer.subarray(0, byteLimit).toString("utf8").replace(/\uFFFD$/u, "");
}

function formatToolContextMessage(results: ToolContextResult[]): string {
  const lines = [
    "Workspace tool results:",
    "Use these local workspace results to answer the user's request. Do not repeat the same read or search unless more specific context is still needed.",
  ];
  for (const result of results) {
    const status = result.status === "success" ? "ok" : "failed";
    lines.push("", `### ${result.call.name}: ${result.title || result.call.id} (${status})`, "```", result.output, "```");
  }
  const message = lines.join("\n");
  if (Buffer.byteLength(message, "utf8") <= maxToolContextBytes) return message;
  return `${clipUtf8(message, maxToolContextBytes)}\n...[truncated: workspace tool context exceeded ${maxToolContextBytes} bytes]`;
}

function formatToolResultContent(result: ToolContextResult): string {
  const status = result.status === "success" ? "ok" : "failed";
  const message = [`${result.call.name}: ${result.title || result.call.id} (${status})`, result.output].join("\n\n");
  if (Buffer.byteLength(message, "utf8") <= maxToolResultBytes) return message;
  return `${clipUtf8(message, maxToolResultBytes)}\n...[truncated: workspace tool result exceeded ${maxToolResultBytes} bytes]`;
}

function assistantToolMessage(content: string, toolCalls: ToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: content.trim() ? content : null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function toolHistorySegmentSummary(assistant: ChatMessage, tools: ChatMessage[]): string {
  const callSummary = (assistant.tool_calls ?? [])
    .map((call) => call.function.name || call.id)
    .filter(Boolean)
    .join(", ") || "tool";
  const outputSummary = tools
    .map((message) => typeof message.content === "string" ? message.content.replace(/\s+/g, " ").trim() : "")
    .filter(Boolean)
    .map((content) => clipUtf8(content, 360))
    .join(" | ");
  return `- ${callSummary}: ${outputSummary || "completed"}`;
}

export function compactToolHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const segments: Array<{ start: number; end: number; summary: string }> = [];
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index];
    if (assistant.role !== "assistant" || !assistant.tool_calls?.length) continue;
    const toolCallIds = new Set(assistant.tool_calls.map((call) => call.id));
    let end = index + 1;
    while (end < messages.length) {
      const next = messages[end];
      if (!next || next.role !== "tool") break;
      if (next.tool_call_id && !toolCallIds.has(next.tool_call_id)) break;
      end += 1;
    }
    if (end > index + 1) {
      segments.push({
        start: index,
        end,
        summary: toolHistorySegmentSummary(assistant, messages.slice(index + 1, end)),
      });
      index = end - 1;
    }
  }
  if (segments.length <= maxStructuredToolHistorySegments) return messages;

  const compactedSegments = segments.slice(0, Math.max(0, segments.length - maxStructuredToolHistorySegments));
  const compactedStarts = new Map(compactedSegments.map((segment) => [segment.start, segment]));
  const retainedStarts = new Map(segments.slice(compactedSegments.length).map((segment) => [segment.start, segment]));
  const summary = clipUtf8(
    [
      "Compacted earlier workspace tool history:",
      ...compactedSegments.map((segment) => segment.summary),
      "Recent tool calls remain available as structured assistant/tool messages.",
    ].join("\n"),
    maxCompactedToolHistoryBytes,
  );
  const compacted: ChatMessage[] = [];
  let insertedSummary = false;
  for (let index = 0; index < messages.length;) {
    const compactedSegment = compactedStarts.get(index);
    if (compactedSegment) {
      if (!insertedSummary) {
        compacted.push({ role: "user", content: summary });
        insertedSummary = true;
      }
      index = compactedSegment.end;
      continue;
    }
    const retainedSegment = retainedStarts.get(index);
    if (retainedSegment) {
      compacted.push(...messages.slice(index, retainedSegment.end));
      index = retainedSegment.end;
      continue;
    }
    compacted.push(messages[index]);
    index += 1;
  }
  return compacted;
}

function messagesForModel(session: Session): ChatMessage[] {
  return compactToolHistoryMessages(session.messages);
}

function isOllamaChatUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/api/chat";
  } catch {
    return false;
  }
}

function isVeilChatUrl(url: string): boolean {
  return isApprovedVeilChatUrl(url);
}

function parseSseLine(line: string): unknown | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function appendOllamaToolCalls(acc: StreamAccumulator, toolCalls: unknown) {
  if (!Array.isArray(toolCalls)) return;
  for (const raw of toolCalls) {
    if (!isRecord(raw)) continue;
    const fn = isRecord(raw.function) ? raw.function : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const index = acc.toolCalls.size;
    acc.toolCalls.set(index, {
      id: `tool-${index}`,
      name,
      arguments: args,
    });
  }
}

function choiceDelta(value: unknown): Record<string, unknown> {
  const obj = isRecord(value) ? value : {};
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  return isRecord(first.delta) ? first.delta : {};
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function reasoningContent(record: Record<string, unknown>): string {
  return (
    textContent(record.reasoning_content) ||
    textContent(record.reasoning) ||
    textContent(record.thinking)
  );
}

function ollamaMessageContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function ollamaMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: ollamaMessageContent(message.content),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
}

function messageContentFromParts(parts: InputPart[]): string | ChatContentPart[] {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n");
  }
  return parts.map((part) =>
    part.type === "image"
      ? { type: "image_url", image_url: { url: part.data_url } }
      : { type: "text", text: part.text },
  );
}

function lastMessageIsToolContext(session: Session): boolean {
  const content = session.messages.at(-1)?.content;
  return typeof content === "string" && content.startsWith("Workspace tool results:");
}

function toolRoleHistorySupported(session: Session): boolean {
  const url = configuredProviderEndpointUrl(session.config.provider.baseURL, session.config.provider.chatEndpointPath);
  return !isOllamaChatUrl(url) && !isVeilChatUrl(url);
}

async function streamOllamaChat(
  session: Session,
  url: string,
  headers: Record<string, string>,
  tools: ReturnType<typeof enabledModelToolSpecs>,
  emit?: (event: UmbraticRunnerEvent) => void,
): Promise<StreamAccumulator> {
  const response = await modelHttpRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: session.config.provider.modelId,
      messages: ollamaMessages(messagesForModel(session)),
      stream: true,
      ...(tools.length ? { tools } : {}),
    }),
    mtls: session.config.provider.mtls,
    signal: session.abortController.signal,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = await readBodyText(response.body, 4096).catch(() => "");
    throw new Error(
      `model request failed: ${response.statusCode} ${response.statusMessage}${body ? ` ${body.slice(0, 400)}` : ""}`,
    );
  }

  const acc: StreamAccumulator = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false };
  let buffer = "";
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as unknown;
    const row = isRecord(parsed) ? parsed : {};
    const message = isRecord(row.message) ? row.message : {};
    const text = textContent(message.content);
    const reasoning = reasoningContent(message);
    if (text) {
      acc.content += text;
      if (emit) {
        acc.emittedContent = true;
        emit({ type: "assistant.delta", taskId: session.taskId, text, at: nowIso() });
      }
    }
    if (reasoning) {
      acc.reasoning += reasoning;
      if (emit) {
        acc.emittedReasoning = true;
        emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: reasoning, at: nowIso() });
      }
    }
    appendOllamaToolCalls(acc, message.tool_calls);
  };
  for await (const chunk of response.body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      processLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  processLine(buffer);
  return acc;
}

function appendToolDelta(acc: StreamAccumulator, delta: Record<string, unknown>) {
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const raw of toolCalls) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === "number" ? raw.index : 0;
    const fn = isRecord(raw.function) ? raw.function : {};
    const existing = acc.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
    acc.toolCalls.set(index, {
      id: typeof raw.id === "string" ? raw.id : existing.id || `tool-${index}`,
      name: typeof fn.name === "string" ? fn.name : existing.name,
      arguments: existing.arguments + (typeof fn.arguments === "string" ? fn.arguments : ""),
    });
  }
}

async function streamModel(session: Session, emit?: (event: UmbraticRunnerEvent) => void): Promise<StreamAccumulator> {
  const tools = enabledModelToolSpecs(session.config.enabledTools);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session.config.provider.apiKey.trim()) {
    headers.Authorization = `Bearer ${session.config.provider.apiKey}`;
  }
  Object.assign(headers, session.config.provider.headers ?? {});
  const url = configuredProviderEndpointUrl(session.config.provider.baseURL, session.config.provider.chatEndpointPath);
  if (isOllamaChatUrl(url)) {
    return streamOllamaChat(session, url, headers, tools, emit);
  }
  const routeIsVeil = isVeilChatUrl(url);
  const messages = routeIsVeil ? messagesForModel(session).filter((message) => message.role !== "system") : messagesForModel(session);
  const requestModel = (includeTools: boolean) =>
    modelHttpRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(routeIsVeil ? {} : { model: session.config.provider.modelId }),
        messages,
        stream: true,
        ...(routeIsVeil && session.config.runtimeProfiles?.length ? { runtime_profiles: session.config.runtimeProfiles } : {}),
        ...(includeTools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
      mtls: session.config.provider.mtls,
      signal: session.abortController.signal,
    });
  let response = await requestModel(true);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = await readBodyText(response.body, 4096).catch(() => "");
    if (tools.length && lastMessageIsToolContext(session)) {
      response = await requestModel(false);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return readOpenAIStream(session, response.body, emit);
      }
      const retryBody = await readBodyText(response.body, 4096).catch(() => "");
      throw new Error(
        `model request failed: ${response.statusCode} ${response.statusMessage}${retryBody ? ` ${retryBody.slice(0, 400)}` : ""}`,
      );
    }
    throw new Error(
      `model request failed: ${response.statusCode} ${response.statusMessage}${body ? ` ${body.slice(0, 400)}` : ""}`,
    );
  }

  return readOpenAIStream(session, response.body, emit);
}

async function readOpenAIStream(
  session: Session,
  body: AsyncIterable<Buffer | string>,
  emit?: (event: UmbraticRunnerEvent) => void,
): Promise<StreamAccumulator> {
  const acc: StreamAccumulator = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false };
  let buffer = "";
  for await (const chunk of body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      const parsed = parseSseLine(line);
      const delta = choiceDelta(parsed);
      const text = textContent(delta.content);
      const reasoning = reasoningContent(delta);
      if (text) {
        acc.content += text;
        if (emit) {
          acc.emittedContent = true;
          emit({ type: "assistant.delta", taskId: session.taskId, text, at: nowIso() });
        }
      }
      if (reasoning) {
        acc.reasoning += reasoning;
        if (emit) {
          acc.emittedReasoning = true;
          emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: reasoning, at: nowIso() });
        }
      }
      appendToolDelta(acc, delta);
      newline = buffer.indexOf("\n");
    }
  }
  return acc;
}

export async function runTurn(session: Session, parts: InputPart[], emit: (event: UmbraticRunnerEvent) => void, replyPermission: ToolContext["askPermission"]) {
  const events = createRunnerEventCoalescer(emit);
  try {
    session.messages.push({ role: "user", content: messageContentFromParts(parts) });
    for (let turn = 0; turn < 12; turn++) {
      const acc = await streamModel(session, events.emit);
      events.flush();
      const toolCalls = Array.from(acc.toolCalls.values()).filter((call) => call.name);
      if (toolCalls.length === 0) {
        session.messages.push({ role: "assistant", content: acc.content || null });
        if (acc.reasoning && !acc.emittedReasoning) {
          events.emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: acc.reasoning, at: nowIso() });
        }
        if (acc.content && !acc.emittedContent) {
          events.emit({ type: "assistant.delta", taskId: session.taskId, text: acc.content, at: nowIso() });
        }
        return;
      }
      const ctx: ToolContext = {
        taskId: session.taskId,
        cwd: session.config.cwd,
        permissionMode: session.config.permissionMode,
        enabledTools: session.config.enabledTools,
        askPermission: replyPermission,
        emitToolOutput(toolCallId, stream, text) {
          events.emit({ type: "tool.output", taskId: session.taskId, toolCallId, stream, text: redactText(text), redacted: true, at: nowIso() });
        },
      };
      const structuredToolHistory = toolRoleHistorySupported(session);
      if (structuredToolHistory) {
        session.messages.push(assistantToolMessage(acc.content, toolCalls));
      } else if (acc.content.trim()) {
        session.messages.push({ role: "assistant", content: acc.content });
      }
      const toolResults: ToolContextResult[] = [];
      for (const toolCall of toolCalls) {
        try {
          const result = await runTool(ctx, events.emit, toolCall);
          toolResults.push({ call: toolCall, title: result.title, output: result.output, status: result.status });
        } catch (error) {
          const failure = toolFailureDetails(error);
          const message = redactText(`Tool failed: ${failure.message}`);
          events.emit({ type: "tool.output", taskId: session.taskId, toolCallId: toolCall.id, stream: "stderr", text: message, redacted: true, at: nowIso() });
          toolResults.push({ call: toolCall, title: toolCall.name, output: message, status: failure.status });
        }
      }
      if (structuredToolHistory) {
        for (const result of toolResults) {
          session.messages.push({
            role: "tool",
            tool_call_id: result.call.id,
            content: formatToolResultContent(result),
          });
        }
      } else {
        session.messages.push({ role: "user", content: formatToolContextMessage(toolResults) });
      }
    }
    throw new Error("model exceeded maximum tool turns");
  } finally {
    events.flush();
  }
}
