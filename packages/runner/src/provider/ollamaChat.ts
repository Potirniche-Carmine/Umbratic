import { nowIso } from "../events.js";
import { modelHttpRequest, readBodyText } from "./http.js";
import { appendOllamaToolCalls, isRecord, reasoningContent, textContent } from "./toolCallAssembler.js";
import type { ProviderStreamInput, ProviderStreamResult } from "./types.js";

export async function streamOllamaChat(input: ProviderStreamInput & { url: string; headers: Record<string, string> }): Promise<ProviderStreamResult> {
  const { session } = input;
  const response = await modelHttpRequest(input.url, {
    method: "POST", headers: input.headers,
    body: JSON.stringify({ model: session.config.provider.modelId, messages: input.messages, stream: true, ...(input.includeTools && input.tools.length ? { tools: input.tools } : {}) }),
    mtls: session.config.provider.mtls, signal: session.abortController.signal,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = await readBodyText(response.body, 4096).catch(() => "");
    throw new Error(`model request failed: ${response.statusCode} ${response.statusMessage}${body ? ` ${body.slice(0, 400)}` : ""}`);
  }
  const acc: ProviderStreamResult = { content: "", reasoning: "", toolCalls: new Map(), emittedContent: false, emittedReasoning: false, actionRequirement: "" };
  let buffer = "";
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const parsed = JSON.parse(line.trim()) as unknown;
    const row = isRecord(parsed) ? parsed : {};
    const message = isRecord(row.message) ? row.message : {};
    const text = textContent(message.content);
    const reasoning = reasoningContent(message);
    if (text) { acc.content += text; if (!input.suppressOutput && input.emit) { acc.emittedContent = true; input.emit({ type: "assistant.delta", taskId: session.taskId, text, at: nowIso() }); } }
    if (reasoning) { acc.reasoning += reasoning; if (!input.suppressOutput && input.emit) { acc.emittedReasoning = true; input.emit({ type: "assistant.reasoning.delta", taskId: session.taskId, text: reasoning, at: nowIso() }); } }
    appendOllamaToolCalls(acc, message.tool_calls);
  };
  for await (const chunk of response.body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) { processLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
  }
  processLine(buffer);
  return acc;
}
