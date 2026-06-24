import { EventEmitter } from "node:events";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import type { UmbraticRunnerEvent } from "./events.js";
import { PermissionBroker } from "./permission.js";

export type InputPart = { type: "text"; text: string } | { type: "image"; data_url: string };
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type Session = {
  id: string;
  taskId: string;
  config: RunnerConfig;
  messages: ChatMessage[];
  abortController: AbortController;
};

export class SessionStore {
  private readonly events = new EventEmitter();
  private readonly sessions = new Map<string, Session>();
  readonly config = loadRunnerConfig();
  readonly permissions = new PermissionBroker((event) => this.emit(event));

  create(): Session {
    const id = `session-${crypto.randomUUID()}`;
    const session: Session = {
      id,
      taskId: this.config.taskId ?? id,
      config: this.config,
      messages: this.config.system ? [{ role: "system", content: this.config.system }] : [],
      abortController: new AbortController(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found");
    return session;
  }

  emit(event: UmbraticRunnerEvent) {
    this.events.emit("event", event);
  }

  subscribe(listener: (event: UmbraticRunnerEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  abort(id: string) {
    const session = this.get(id);
    session.abortController.abort();
    this.permissions.denyAll(session.taskId);
  }
}
