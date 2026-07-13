import { nowIso, toolFailureRepairable, type AttemptRecord, type RunnerTurnSummary, type UmbraticRunnerEvent } from "./events.js";
import type { ChatContentPart, ChatMessage, InputPart, Session } from "./session.js";
import { redactText } from "./policy.js";
import { buildToolPlan } from "./tools/planner.js";
import { ToolScheduler } from "./tools/scheduler.js";
import { executionResultText, finalizeToolExecution } from "./tools/results.js";
import { toolNameFromProvider, type ToolCall as RuntimeToolCall, type ToolRuntimeContext } from "./tools/types.js";
import type { ToolPlan } from "./tools/plan.js";
import type { ToolContext, ToolErrorCode, ToolResult, ToolResultStatus } from "./tools/common.js";
import { configuredProviderEndpointUrl } from "./provider/local.js";
import { streamProviderChat } from "./provider/chat.js";
import { providerCapabilities } from "./provider/historyEncoder.js";
import { parseToolArguments } from "./tools/schema.js";

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
  actionRequirement: "" | "change" | "execute" | "inspect" | "change-and-execute";
  toolPlan?: ToolPlan;
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

export function normalizedTurnToolCalls(calls: ReadonlyMap<number, ToolCall>, turnId: string): ToolCall[] {
  const seen = new Set<string>();
  return [...calls.entries()]
    .filter(([, call]) => !!call.name)
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => {
      const supplied = call.id.trim();
      const id = supplied && !seen.has(supplied) ? supplied : `${turnId}-tool-${index}`;
      seen.add(id);
      return { ...call, id };
    });
}

function repairInspectionInventoryRead(calls: ToolCall[], required: boolean): ToolCall[] {
  if (!required) return calls;
  let repaired = false;
  return calls.map((call) => {
    if (repaired || toolNameFromProvider(call.name).name !== "read") return call;
    try {
      const input = parseToolArguments(call.arguments);
      if (typeof input.filePath === "string" && input.filePath.trim()) return call;
    } catch {
      // A required exhaustive inspection has one unambiguous, read-only starting point.
    }
    repaired = true;
    return { ...call, arguments: JSON.stringify({ filePath: ".", depth: 3 }) };
  });
}

function announcesWorkspaceToolUseWithoutCalling(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text || text.length > 600) return false;
  return /\b(?:let me|i(?:'ll| will| need to| should))\s+(?:now\s+)?(?:read|inspect|check|search|open|list|look at|review|run|test|verify|edit|write|create|update|fetch|grab)\b/i.test(text);
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
  return providerCapabilities(url).structuredToolHistory;
}

async function streamModel(
  session: Session,
  emit?: (event: UmbraticRunnerEvent) => void,
  options: { includeTools?: boolean; requireToolCall?: boolean; suppressOutput?: boolean; actionRequirementKnown?: boolean; guardToolAnnouncements?: boolean } = {},
): Promise<StreamAccumulator> {
  const url = configuredProviderEndpointUrl(session.config.provider.baseURL, session.config.provider.chatEndpointPath);
  const capabilities = providerCapabilities(url);
  const toolPlan = buildToolPlan({
    enabledTools: session.config.enabledTools,
    includeContextRetrieval: session.contextStore.hasEntries(),
    includeSkillReader: session.config.skills.length > 0,
    includeWorkspaceGraph: !!session.workspaceGraph,
    providerParallelToolCalls: capabilities.parallelToolCalls,
  });
  const includeTools = options.includeTools !== false;
  const acc = await streamProviderChat({
    session,
    messages: messagesForModel(session),
    tools: toolPlan.modelSpecs,
    includeTools,
    requireToolCall: !!options.requireToolCall,
    parallelToolCalls: toolPlan.parallelToolCalls,
    suppressOutput: !!options.suppressOutput,
    actionRequirementKnown: !!options.actionRequirementKnown,
    guardToolAnnouncements: !!options.guardToolAnnouncements,
    emit,
    lastMessageIsToolContext: lastMessageIsToolContext(session),
  });
  return { ...acc, toolPlan };
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
  const scheduler = new ToolScheduler();
  const summary = emptyRunTurnSummary();
  try {
    session.messages.push({ role: "user", content: messageContentFromParts(parts) });
    let consecutiveFailedToolTurns = 0;
    let previousToolSignature = "";
    let repeatedToolTurns = 0;
    let actionRequirement: StreamAccumulator["actionRequirement"] = "";
    let actionRetries = 0;
    let announcedToolUseRetries = 0;
    let finalAnswerPrompted = false;
    let changedWorkspace = false;
    let executedCommand = false;
    let completedWorkspaceInventory = false;
    const actionEvidenceSatisfied = () => {
      if (actionRequirement === "change") return changedWorkspace;
      if (actionRequirement === "execute") return executedCommand;
      if (actionRequirement === "inspect") return completedWorkspaceInventory;
      if (actionRequirement === "change-and-execute") return changedWorkspace && executedCommand;
      return true;
    };
    for (let turn = 0; turn < maxToolTurns; turn++) {
      const readyForFinalAnswer = !!actionRequirement && actionEvidenceSatisfied();
      if (readyForFinalAnswer && !finalAnswerPrompted) {
        finalAnswerPrompted = true;
        session.messages.push({
          role: "user",
          content: "The required workspace evidence is now available. Provide the complete final answer to the original request. Do not announce additional work unless you make the structured tool call in this turn.",
        });
      }
      const acc = await streamModel(session, events.emit, {
        requireToolCall: !!actionRequirement && actionRetries > 0 && !actionEvidenceSatisfied(),
        suppressOutput: !!actionRequirement && !readyForFinalAnswer,
        actionRequirementKnown: !!actionRequirement,
        guardToolAnnouncements: !actionRequirement || readyForFinalAnswer,
      });
      actionRequirement ||= acc.actionRequirement;
      recordModelTurn(summary, acc);
      events.flush();
      const toolCalls = repairInspectionInventoryRead(
        normalizedTurnToolCalls(acc.toolCalls, `${session.id}-turn-${summary.turns}`),
        actionRequirement === "inspect" && !completedWorkspaceInventory,
      );
      summary.toolCalls += toolCalls.length;
      if (toolCalls.length === 0) {
        const changeSatisfied = (actionRequirement !== "change" && actionRequirement !== "change-and-execute") || changedWorkspace;
        const executeSatisfied = (actionRequirement !== "execute" && actionRequirement !== "change-and-execute") || executedCommand;
        const inspectionSatisfied = actionRequirement !== "inspect" || completedWorkspaceInventory;
        if (actionRequirement && (!changeSatisfied || !executeSatisfied || !inspectionSatisfied)) {
          if (actionRetries < 2) {
            actionRetries += 1;
            const missing = [
              !changeSatisfied ? "a successful file edit" : "",
              !executeSatisfied ? "a successful command run" : "",
              !inspectionSatisfied ? "a complete workspace directory read of . (continue with offset if the listing is partial)" : "",
            ].filter(Boolean).join(" and ");
            session.messages.push({
              role: "user",
              content: `The requested workspace action is not complete. It still requires ${missing}. Use the available structured workspace tools now. Do not answer with code fences or simulated command output.`,
            });
            continue;
          }
          const missing = [
            !changeSatisfied ? "change the requested file" : "",
            !executeSatisfied ? "run the requested verification command" : "",
            !inspectionSatisfied ? "complete the workspace directory inventory" : "",
          ].filter(Boolean).join(" or ");
          const fallback = `I couldn't complete the requested workspace action because the model did not use a structured tool call to ${missing}. I won't claim that the remaining work succeeded.`;
          summary.assistantTextChars += fallback.length;
          appendAssistantCompletion(session, { ...acc, content: "", reasoning: "", emittedContent: false, emittedReasoning: false }, events, fallback);
          return summary;
        }
        if (actionRequirement && announcesWorkspaceToolUseWithoutCalling(acc.content)) {
          if (announcedToolUseRetries < 2) {
            announcedToolUseRetries += 1;
            session.messages.push({
              role: "user",
              content: "Your previous response only announced future workspace work. Either use a structured tool call now, or provide the complete final answer from the successful tool results already available. Do not end with a promise to read, inspect, check, or run something later.",
            });
            continue;
          }
          session.messages.push({
            role: "user",
            content: "Provide the complete final answer now using the successful workspace results already available. Do not announce more work.",
          });
          return await finishWithoutTools(
            session,
            summary,
            events,
            "The workspace inspection completed, but the final summary could not be generated.",
          );
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
      const ctx: ToolRuntimeContext = {
        taskId: session.taskId,
        cwd: session.config.cwd,
        permissionMode: session.config.permissionMode,
        enabledTools: session.config.enabledTools,
        skills: session.config.skills,
        contextStore: session.contextStore,
        workspaceGraph: session.workspaceGraph,
        signal: session.abortController.signal,
        askPermission: replyPermission,
        emitToolOutput(toolCallId, stream, text) {
          events.emit({ type: "tool.execution.update", taskId: session.taskId, toolCallId, stream, text: redactText(text), at: nowIso() });
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
      const plan = acc.toolPlan ?? buildToolPlan({
        enabledTools: session.config.enabledTools,
        includeContextRetrieval: session.contextStore.hasEntries(),
        includeSkillReader: session.config.skills.length > 0,
        includeWorkspaceGraph: !!session.workspaceGraph,
      });
      const runtimeCalls: RuntimeToolCall[] = toolCalls.map((call, index) => ({
        id: call.id,
        name: toolNameFromProvider(call.name),
        payload: { kind: "function", arguments: call.arguments },
        index,
      }));
      const executionResults = await scheduler.execute(plan, ctx, events.emit, runtimeCalls);
      for (let index = 0; index < toolCalls.length; index += 1) {
          const toolCall = toolCalls[index];
          const execution = executionResults[index];
          const finalized = finalizeToolExecution({
            taskId: session.taskId,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            result: execution,
            contextStore: session.contextStore,
            emit: events.emit,
          });
          const result = finalized.legacy;
          recordNonSuccessToolResult(summary, toolCall.name, result);
          if (result.status === "success" && (toolCall.name === "edit" || toolCall.name === "write")) changedWorkspace = true;
          if (result.status === "success" && toolCall.name === "command") executedCommand = true;
          if (
            result.status === "success"
            && toolCall.name === "read"
            && result.title === "."
            && /(?:^|\n)Listing status: complete(?:\n|$)/.test(result.output)
          ) {
            completedWorkspaceInventory = true;
          }
          toolResults.push({ call: toolCall, title: result.title, output: finalized.modelOutput, status: result.status });
          if (execution.status !== "success") {
            const message = redactText(executionResultText(execution));
            events.emit({ type: "tool.output", taskId: session.taskId, toolCallId: toolCall.id, stream: "stderr", text: message, redacted: true, at: nowIso() });
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
