import { nowIso, type UmbraticRunnerEvent } from "../events.js";
import { modelHttpRequest, readBodyText } from "./http.js";
import { appendOpenAIToolDelta, invalidateTruncatedToolArguments, isRecord, reasoningContent, textContent } from "./toolCallAssembler.js";
import type { ProviderStreamInput, ProviderStreamResult } from "./types.js";

function parseSseLine(line: string): unknown | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try { return JSON.parse(data) as unknown; } catch { return null; }
}

function choice(value: unknown): { delta: Record<string, unknown>; finishReason?: string } {
  const obj = isRecord(value) ? value : {};
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  return { delta: isRecord(first.delta) ? first.delta : {}, ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}) };
}

export async function readOpenAIStream(taskId: string, body: AsyncIterable<Buffer | string>, emit?: (event: UmbraticRunnerEvent) => void): Promise<ProviderStreamResult> {
  const acc: ProviderStreamResult = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false, actionRequirement: "" };
  let buffer = "";
  let completed = false;
  let truncated = false;
  for await (const chunk of body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "data: [DONE]") completed = true;
      const row = choice(parseSseLine(line));
      if (row.finishReason === "length") truncated = true;
      const text = textContent(row.delta.content);
      const reasoning = reasoningContent(row.delta);
      if (text) { acc.content += text; if (emit) { acc.emittedContent = true; emit({ type: "assistant.delta", taskId, text, at: nowIso() }); } }
      if (reasoning) { acc.reasoning += reasoning; if (emit) { acc.emittedReasoning = true; emit({ type: "assistant.reasoning.delta", taskId, text: reasoning, at: nowIso() }); } }
      appendOpenAIToolDelta(acc, row.delta);
      newline = buffer.indexOf("\n");
    }
  }
  if (!completed) throw new Error("model stream ended before the completion marker");
  if (truncated && acc.toolCalls.size) invalidateTruncatedToolArguments(acc);
  return acc;
}

export async function streamOpenAIChat(input: ProviderStreamInput & { url: string; headers: Record<string, string>; veil: boolean; lastMessageIsToolContext: boolean }): Promise<ProviderStreamResult> {
  const { session } = input;
  const request = (includeTools: boolean) => modelHttpRequest(input.url, {
    method: "POST", headers: input.headers,
    body: JSON.stringify({
      ...(input.veil ? {} : { model: session.config.provider.modelId }), messages: input.messages, stream: true,
      ...(input.veil && session.config.skills.length ? { skills: session.config.skills.map(({ id, name, description, source }) => ({ id, name, description, source })) } : {}),
      ...(includeTools && input.tools.length ? { tools: input.tools, tool_choice: input.requireToolCall ? "required" : "auto" } : {}),
      ...(includeTools && input.tools.length && input.parallelToolCalls ? { parallel_tool_calls: true } : {}),
    }),
    mtls: session.config.provider.mtls, signal: session.abortController.signal,
  });
  let response = await request(input.includeTools);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = await readBodyText(response.body, 4096).catch(() => "");
    if (input.includeTools && input.tools.length && input.lastMessageIsToolContext) {
      response = await request(false);
      if (response.statusCode >= 200 && response.statusCode < 300) return readOpenAIStream(session.taskId, response.body, input.emit);
      const retryBody = await readBodyText(response.body, 4096).catch(() => "");
      throw new Error(`model request failed: ${response.statusCode} ${response.statusMessage}${retryBody ? ` ${retryBody.slice(0, 400)}` : ""}`);
    }
    throw new Error(`model request failed: ${response.statusCode} ${response.statusMessage}${body ? ` ${body.slice(0, 400)}` : ""}`);
  }
  const header = response.headers["x-umbratic-action-required"];
  const actionRequirement = header === "change" || header === "execute" || header === "change-and-execute" ? header : "";
  const suppress = !!actionRequirement || input.suppressOutput;
  const streamEmit = suppress ? undefined : input.emit;
  const acc = await readOpenAIStream(session.taskId, response.body, streamEmit);
  acc.actionRequirement = actionRequirement;
  return acc;
}
