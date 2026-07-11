import { nowIso, toolFailureRepairable, type AttemptRecord, type RunnerTurnSummary, type UmbraticRunnerEvent } from "./events.js";
import type { ChatContentPart, ChatMessage, InputPart, Session } from "./session.js";
import { compressToolResult } from "./context/contentRouter.js";
import { redactText } from "./policy.js";
import { enabledModelToolSpecs, runTool } from "./tools/index.js";
import { toolFailureDetails, type ToolContext, type ToolErrorCode, type ToolResult, type ToolResultStatus } from "./tools/common.js";
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
  actionRequirement: "" | "change" | "execute" | "change-and-execute";
};

type ToolContextResult = {
  call: ToolCall;
  title: string;
  output: string;
  status: ToolResultStatus;
};

export type RunTurnSummary = RunnerTurnSummary;

const maxToolContextBytes = 56 * 1024;
const maxToolResultBytes = 24 * 1024;
const maxStructuredToolHistorySegments = 4;
const maxCompactedToolHistoryBytes = 12 * 1024;
const maxToolTurns = 64;
const maxConsecutiveFailedToolTurns = 8;
const maxRepeatedToolTurns = 3;
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

function emptyRunTurnSummary(): RunTurnSummary {
  return {
    status: "completed",
    turns: 0,
    assistantTextChars: 0,
    reasoningTextChars: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    attempts: [],
  };
}

function recordToolFailure(
  summary: RunTurnSummary,
  toolKind: string,
  failure: { status: ToolResultStatus; errorCode?: ToolErrorCode; message: string },
) {
  summary.failedToolCalls += 1;
  summary.lastToolFailure = {
    toolKind,
    status: failure.status,
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    message: redactText(failure.message, 500),
  };
  const phase: AttemptRecord["phase"] = failure.status === "permission_denied"
    ? "permission"
    : failure.status === "validation_error"
      ? "tool-validate"
      : "execute";
  summary.attempts.push({
    attempt: summary.attempts.length + 1,
    phase,
    code: failure.errorCode ?? "runtime_error",
    repairable: toolFailureRepairable(failure.status, failure.errorCode),
    toolId: toolKind,
    redactedSummary: redactText(failure.message, 500),
  });
}

function recordNonSuccessToolResult(summary: RunTurnSummary, toolKind: string, result: ToolResult) {
  if (result.status === "success") return;
  const firstOutputLine = result.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  recordToolFailure(summary, toolKind, {
    status: result.status,
    errorCode: result.errorCode,
    message: result.errorMessage || firstOutputLine || `${toolKind} returned ${result.status}.`,
  });
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

function compactStructuredToolHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
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

function compactProseToolHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const toolContextIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Workspace tool results:"))
    .map(({ index }) => index);
  if (toolContextIndexes.length <= maxStructuredToolHistorySegments) return messages;

  const removed = new Set(toolContextIndexes.slice(0, -maxStructuredToolHistorySegments));
  const summary = clipUtf8(
    [
      "Compacted earlier workspace tool context:",
      ...toolContextIndexes.slice(0, -maxStructuredToolHistorySegments).map((index) => {
        const content = messages[index]?.content;
        return `- ${clipUtf8(typeof content === "string" ? content.replace(/\s+/g, " ").trim() : "tool completed", 360)}`;
      }),
      "Recent workspace tool results remain available in full.",
    ].join("\n"),
    maxCompactedToolHistoryBytes,
  );
  const compacted: ChatMessage[] = [];
  let insertedSummary = false;
  for (let index = 0; index < messages.length; index++) {
    if (!removed.has(index)) {
      compacted.push(messages[index]);
      continue;
    }
    if (!insertedSummary) {
      compacted.push({ role: "user", content: summary });
      insertedSummary = true;
    }
  }
  return compacted;
}

export function compactToolHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  return compactProseToolHistoryMessages(compactStructuredToolHistoryMessages(messages));
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

function isSseDoneLine(line: string): boolean {
  return line.startsWith("data:") && line.slice(5).trim() === "[DONE]";
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

  const acc: StreamAccumulator = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false, actionRequirement: "" };
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

async function streamModel(
  session: Session,
  emit?: (event: UmbraticRunnerEvent) => void,
  options: { includeTools?: boolean; suppressOutput?: boolean } = {},
): Promise<StreamAccumulator> {
  const tools = enabledModelToolSpecs(session.config.enabledTools, {
    includeContextRetrieval: session.contextStore.hasEntries(),
    includeSkillReader: session.config.skills.length > 0,
  });
  const includeTools = options.includeTools !== false;
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
        ...(routeIsVeil && session.config.skills.length ? {
          skills: session.config.skills.map(({ id, name, description, source }) => ({ id, name, description, source })),
        } : {}),
        ...(includeTools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
      mtls: session.config.provider.mtls,
      signal: session.abortController.signal,
    });
  let response = await requestModel(includeTools);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = await readBodyText(response.body, 4096).catch(() => "");
    if (includeTools && tools.length && lastMessageIsToolContext(session)) {
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

  const header = response.headers["x-umbratic-action-required"];
  const actionRequirement = header === "change" || header === "execute" || header === "change-and-execute" ? header : "";
  const acc = await readOpenAIStream(session, response.body, actionRequirement || options.suppressOutput ? undefined : emit);
  acc.actionRequirement = actionRequirement;
  return acc;
}

async function readOpenAIStream(
  session: Session,
  body: AsyncIterable<Buffer | string>,
  emit?: (event: UmbraticRunnerEvent) => void,
): Promise<StreamAccumulator> {
  const acc: StreamAccumulator = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false, actionRequirement: "" };
  let buffer = "";
  let completed = false;
  for await (const chunk of body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (isSseDoneLine(line)) completed = true;
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
  if (!completed) throw new Error("model stream ended before the completion marker");
  return acc;
}

function recordModelTurn(summary: RunTurnSummary, acc: StreamAccumulator) {
  summary.turns += 1;
  summary.assistantTextChars += acc.content.length;
  summary.reasoningTextChars += acc.reasoning.length;
}

function appendAssistantCompletion(
  session: Session,
  acc: StreamAccumulator,
  events: ReturnType<typeof createRunnerEventCoalescer>,
  fallback = "",
) {
  const content = acc.content || fallback;
  session.messages.push({ role: "assistant", content: content || null });
  if (acc.reasoning && !acc.emittedReasoning) {
    events.emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: acc.reasoning, at: nowIso() });
  }
  if (content && !acc.emittedContent) {
    events.emit({ type: "assistant.delta", taskId: session.taskId, text: content, at: nowIso() });
  }
}

async function finishWithoutTools(
  session: Session,
  summary: RunTurnSummary,
  events: ReturnType<typeof createRunnerEventCoalescer>,
  fallback: string,
): Promise<RunTurnSummary> {
  try {
    const acc = await streamModel(session, events.emit, { includeTools: false });
    recordModelTurn(summary, acc);
    events.flush();
    const content = acc.content || fallback;
    if (!acc.content && content) summary.assistantTextChars += content.length;
    appendAssistantCompletion(session, acc, events, content);
  } catch {
    summary.assistantTextChars += fallback.length;
    appendAssistantCompletion(
      session,
      { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false, actionRequirement: "" },
      events,
      fallback,
    );
  }
  return summary;
}

export async function runTurn(session: Session, parts: InputPart[], emit: (event: UmbraticRunnerEvent) => void, replyPermission: ToolContext["askPermission"]): Promise<RunTurnSummary> {
  const events = createRunnerEventCoalescer(emit);
  const summary = emptyRunTurnSummary();
  try {
    session.messages.push({ role: "user", content: messageContentFromParts(parts) });
    let consecutiveFailedToolTurns = 0;
    let previousToolSignature = "";
    let repeatedToolTurns = 0;
    let actionRequirement: StreamAccumulator["actionRequirement"] = "";
    let actionRetries = 0;
    let changedWorkspace = false;
    let executedCommand = false;
    for (let turn = 0; turn < maxToolTurns; turn++) {
      const acc = await streamModel(session, events.emit, { suppressOutput: !!actionRequirement });
      actionRequirement ||= acc.actionRequirement;
      recordModelTurn(summary, acc);
      events.flush();
      const toolCalls = Array.from(acc.toolCalls.values()).filter((call) => call.name);
      summary.toolCalls += toolCalls.length;
      if (toolCalls.length === 0) {
        const changeSatisfied = (actionRequirement !== "change" && actionRequirement !== "change-and-execute") || changedWorkspace;
        const executeSatisfied = (actionRequirement !== "execute" && actionRequirement !== "change-and-execute") || executedCommand;
        if (actionRequirement && (!changeSatisfied || !executeSatisfied)) {
          if (actionRetries < 2) {
            actionRetries += 1;
            const missing = [!changeSatisfied ? "a successful file edit" : "", !executeSatisfied ? "a successful command run" : ""].filter(Boolean).join(" and ");
            session.messages.push({
              role: "user",
              content: `The requested workspace action is not complete. It still requires ${missing}. Use the available structured workspace tools now. Do not answer with code fences or simulated command output.`,
            });
            continue;
          }
          const missing = [!changeSatisfied ? "change the requested file" : "", !executeSatisfied ? "run the requested verification command" : ""].filter(Boolean).join(" or ");
          const fallback = `I couldn't complete the requested workspace action because the model did not use a structured tool call to ${missing}. I won't claim that the remaining work succeeded.`;
          summary.assistantTextChars += fallback.length;
          appendAssistantCompletion(session, { ...acc, content: "", reasoning: "", emittedContent: false, emittedReasoning: false }, events, fallback);
          return summary;
        }
        appendAssistantCompletion(session, acc, events);
        return summary;
      }
      const toolSignature = toolCalls.map((call) => `${call.name}\u0000${call.arguments}`).join("\u0001");
      if (toolSignature === previousToolSignature) {
        repeatedToolTurns += 1;
      } else {
        previousToolSignature = toolSignature;
        repeatedToolTurns = 1;
      }
      const ctx: ToolContext = {
        taskId: session.taskId,
        cwd: session.config.cwd,
        permissionMode: session.config.permissionMode,
        enabledTools: session.config.enabledTools,
        skills: session.config.skills,
        contextStore: session.contextStore,
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
          const compressed = compressToolResult({
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            title: result.title,
            output: result.output,
            status: result.status,
            contextStore: session.contextStore,
          });
          recordNonSuccessToolResult(summary, toolCall.name, result);
          if (result.status === "success" && (toolCall.name === "edit" || toolCall.name === "write")) changedWorkspace = true;
          if (result.status === "success" && toolCall.name === "command") executedCommand = true;
          if (compressed.modified) {
            events.emit({
              type: "context.compressed",
              taskId: session.taskId,
              toolCallId: toolCall.id,
              toolKind: toolCall.name,
              kind: compressed.kind,
              strategy: compressed.strategy,
              ...(compressed.markerHash ? { hash: compressed.markerHash } : {}),
              originalBytes: compressed.originalBytes,
              outputBytes: compressed.outputBytes,
              at: nowIso(),
            });
          }
          toolResults.push({ call: toolCall, title: result.title, output: compressed.output, status: result.status });
        } catch (error) {
          const failure = toolFailureDetails(error);
          recordToolFailure(summary, toolCall.name, failure);
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
      if (toolResults.every((result) => result.status !== "success")) {
        consecutiveFailedToolTurns += 1;
      } else {
        consecutiveFailedToolTurns = 0;
      }
      if (consecutiveFailedToolTurns >= maxConsecutiveFailedToolTurns) {
        return await finishWithoutTools(
          session,
          summary,
          events,
          "I stopped after repeated workspace tool failures. Review the latest tool output above before trying a different approach.",
        );
      }
      if (repeatedToolTurns >= maxRepeatedToolTurns) {
        return await finishWithoutTools(
          session,
          summary,
          events,
          "I stopped after repeating the same workspace tool call without making progress. The latest tool output is available above.",
        );
      }
    }
    return await finishWithoutTools(
      session,
      summary,
      events,
      "I reached the workspace tool safety limit before finishing. The latest tool output is available above.",
    );
  } finally {
    events.flush();
  }
}
