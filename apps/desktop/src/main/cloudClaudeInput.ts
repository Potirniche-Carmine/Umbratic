import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

/** Keep the SDK input stream open for steering until the native run finishes. */
export class PromptGate {
  private pending: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  send(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]): string {
    if (this.closed) throw new Error("This turn has finished. Send the prompt as a new turn.");
    const uuid = randomUUID();
    this.pending.push({ type: "user", session_id: "", parent_tool_use_id: null, uuid, priority, message: { role: "user", content } });
    this.wake?.();
    return uuid;
  }
  close(): void { this.closed = true; this.pending = []; this.wake?.(); }
  async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.pending.shift();
      if (message) yield message;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export function claudePromptContent(prompt: string, images: { path: string; mimeType: string }[]): SDKUserMessage["message"]["content"] {
  if (!images.length) return prompt;
  return [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...images.map(image => image.mimeType === "application/pdf"
    ? ({ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: fs.readFileSync(image.path).toString("base64") } })
    : image.mimeType.startsWith("image/") ? ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: fs.readFileSync(image.path).toString("base64") } })
      : ({ type: "document" as const, source: { type: "text" as const, media_type: "text/plain" as const, data: fs.readFileSync(image.path, "utf8") } }))];
}
