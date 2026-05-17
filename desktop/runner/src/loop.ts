import { nowIso, type AegisRunnerEvent } from "./events.js";
import type { ChatContentPart, InputPart, Session } from "./session.js";
import { redactText } from "./policy.js";
import { runTool, toolSpecs } from "./tools/index.js";
import type { ToolContext } from "./tools/common.js";
import { modelHttpRequest, readBodyText } from "./provider/http.js";

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

function chatCompletionsUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
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

async function streamModel(session: Session, emit?: (event: AegisRunnerEvent) => void): Promise<StreamAccumulator> {
  const response = await modelHttpRequest(chatCompletionsUrl(session.config.provider.baseURL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.config.provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: session.config.provider.modelId,
      messages: session.messages,
      stream: true,
      tools: toolSpecs,
      tool_choice: "auto",
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
  for await (const chunk of response.body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      const parsed = parseSseLine(line);
      const delta = choiceDelta(parsed);
      const text = textContent(delta.content);
      const reasoning = textContent(delta.reasoning_content) || textContent(delta.reasoning);
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

export async function runTurn(session: Session, parts: InputPart[], emit: (event: AegisRunnerEvent) => void, replyPermission: ToolContext["askPermission"]) {
  session.messages.push({ role: "user", content: messageContentFromParts(parts) });
  let hasCompletedToolRound = false;
  for (let turn = 0; turn < 12; turn++) {
    const acc = await streamModel(session, hasCompletedToolRound ? emit : undefined);
    const toolCalls = Array.from(acc.toolCalls.values()).filter((call) => call.name);
    session.messages.push({
      role: "assistant",
      content: acc.content || null,
      tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    });
    if (toolCalls.length === 0) {
      if (acc.reasoning && !acc.emittedReasoning) {
        emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: acc.reasoning, at: nowIso() });
      }
      if (acc.content && !acc.emittedContent) {
        emit({ type: "assistant.delta", taskId: session.taskId, text: acc.content, at: nowIso() });
      }
      return;
    }
    hasCompletedToolRound = true;

    const ctx: ToolContext = {
      taskId: session.taskId,
      cwd: session.config.cwd,
      permissionMode: session.config.permissionMode,
      askPermission: replyPermission,
      emitToolOutput(toolCallId, stream, text) {
        emit({ type: "tool.output", taskId: session.taskId, toolCallId, stream, text: redactText(text), redacted: true, at: nowIso() });
      },
    };
    for (const toolCall of toolCalls) {
      try {
        const result = await runTool(ctx, emit, toolCall);
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result.output });
      } catch (error) {
        const message = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
        emit({ type: "tool.output", taskId: session.taskId, toolCallId: toolCall.id, stream: "stderr", text: message, redacted: true, at: nowIso() });
        emit({ type: "tool.finished", taskId: session.taskId, toolCallId: toolCall.id, exitCode: 1, at: nowIso() });
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: message });
      }
    }
  }
  throw new Error("model exceeded maximum tool turns");
}
