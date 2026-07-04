import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";
import { nowIso, type UmbraticRunnerEvent } from "./events.js";
import { runTurn } from "./loop.js";
import { redactText } from "./policy.js";
import type { InputPart } from "./session.js";
import { SessionStore } from "./session.js";

const localProtocol = "http";
const maxLocalJsonBodyBytes = 512 * 1024;

class HttpBoundaryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "HttpBoundaryError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxLocalJsonBodyBytes) {
      throw new HttpBoundaryError(413, "request_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = text ? JSON.parse(text) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpBoundaryError(400, "invalid_json_shape", "Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw new HttpBoundaryError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function noStoreHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    ...headers,
  };
}

function sendJson(response: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}) {
  response.writeHead(status, noStoreHeaders({ "Content-Type": "application/json", ...headers }));
  response.end(JSON.stringify(value));
}

function sendNoContent(response: http.ServerResponse) {
  response.writeHead(204, noStoreHeaders());
  response.end();
}

function sendError(response: http.ServerResponse, status: number, code: string, message: string, headers: http.OutgoingHttpHeaders = {}) {
  sendJson(response, status, { error: message, code }, headers);
}

async function diagnosticLogStatus(store: SessionStore) {
  const metadata = store.diagnostics.metadata();
  if (!metadata.logPath) return metadata;
  try {
    const stat = await fs.promises.stat(metadata.logPath);
    return {
      ...metadata,
      exists: stat.isFile(),
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...metadata, exists: false, sizeBytes: 0 };
    }
    throw error;
  }
}

async function sendDiagnosticLog(response: http.ServerResponse, store: SessionStore) {
  const metadata = store.diagnostics.metadata();
  if (!metadata.enabled || !metadata.logPath) {
    sendError(response, 404, "diagnostics_unavailable", "Diagnostics are not available.");
    return;
  }
  try {
    await fs.promises.access(metadata.logPath, fs.constants.R_OK);
  } catch {
    sendError(response, 404, "diagnostics_not_found", "Diagnostics log has not been created yet.");
    return;
  }
  response.writeHead(200, noStoreHeaders({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="${path.basename(metadata.logPath)}"`,
  }));
  const stream = fs.createReadStream(metadata.logPath, { encoding: "utf8" });
  stream.once("error", () => {
    if (!response.writableEnded) response.end();
  });
  stream.pipe(response);
}

function isAuthorized(request: http.IncomingMessage, password: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded === `umbratic-runner:${password}`;
}

function inputPartsFromBody(body: Record<string, unknown>): InputPart[] {
  const rawParts = Array.isArray(body.parts) ? body.parts : [];
  const parts: InputPart[] = [];
  for (const part of rawParts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "image" && typeof record.data_url === "string" && record.data_url.startsWith("data:image/")) {
      parts.push({ type: "image", data_url: record.data_url });
      continue;
    }
    const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
    if (text) {
      parts.push({ type: "text", text });
    }
  }
  if (parts.length === 0 && typeof body.prompt === "string" && body.prompt.trim()) {
    parts.push({ type: "text", text: body.prompt.trim() });
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

function writeSse(response: http.ServerResponse, event: UmbraticRunnerEvent) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publicErrorDetail(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : String(error);
  return redactText(message.replace(/\s+/g, " "), 1000);
}

export function runnerErrorEvent(taskId: string, error: unknown): UmbraticRunnerEvent {
  const detail = publicErrorDetail(error);
  return {
    type: "runner.error",
    taskId,
    category: "loop",
    code: "loop_error",
    message: detail ? `Runner turn failed: ${detail}` : "Runner turn failed.",
    ...(detail ? { detail } : {}),
    at: nowIso(),
  };
}

export async function listen(opts: { hostname: string; port: number; password: string }): Promise<{ url: string; close(): Promise<void> }> {
  const store = new SessionStore();
  const streams = new Set<http.ServerResponse>();
  const unsubscribe = store.subscribe((event) => {
    for (const stream of streams) writeSse(stream, event);
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `${localProtocol}://${opts.hostname}:${opts.port}`);
      if (!isAuthorized(request, opts.password)) {
        sendError(response, 401, "unauthorized", "Unauthorized", { "WWW-Authenticate": "Basic" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/event") {
        response.writeHead(200, noStoreHeaders({
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        }));
        response.flushHeaders?.();
        response.write(": connected\n\n");
        const heartbeat = setInterval(() => {
          response.write(": heartbeat\n\n");
        }, 15000);
        streams.add(response);
        request.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/diagnostics") {
        sendJson(response, 200, await diagnosticLogStatus(store));
        return;
      }

      if (request.method === "GET" && url.pathname === "/diagnostics/export") {
        await sendDiagnosticLog(response, store);
        return;
      }

      if (request.method === "POST" && url.pathname === "/session") {
        const session = store.create();
        sendJson(response, 200, { id: session.id });
        return;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const session = store.get(decodeURIComponent(promptMatch[1]));
        const body = await readJson(request);
        if (store.config.modelBoundary === "managed" && Object.hasOwn(body, "system")) {
          sendError(response, 400, "protected_system_prompt", "System prompts are managed by Veil.");
          return;
        }
        const parts = inputPartsFromBody(body);
        const system = typeof body.system === "string" ? body.system : "";
        if (system && !session.messages.some((message) => message.role === "system")) {
          session.messages.unshift({ role: "system", content: system });
        }
        void runTurn(session, parts, (event) => store.emit(event), (input) =>
          store.permissions.request({ taskId: session.taskId, ...input }),
        )
          .then((summary) => {
            store.emit({ type: "session.idle", taskId: session.taskId, sessionId: session.id, summary, at: nowIso() });
          })
          .catch((error) => {
            store.emit(runnerErrorEvent(session.taskId, error));
          });
        sendNoContent(response);
        return;
      }

      const permissionMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permissionMatch) {
        const body = await readJson(request);
        const permissionId = decodeURIComponent(permissionMatch[1]);
        const allow = body.reply === "once" || body.reply === "allow" || body.response === "once";
        const replied = store.permissions.reply(permissionId, allow ? "allow" : "deny");
        sendJson(response, replied ? 200 : 404, replied);
        return;
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (request.method === "POST" && abortMatch) {
        store.abort(decodeURIComponent(abortMatch[1]));
        sendNoContent(response);
        return;
      }

      sendError(response, 404, "not_found", "Not found");
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof HttpBoundaryError) {
        sendError(response, error.status, error.code, error.publicMessage);
        return;
      }
      if (error instanceof Error && error.message === "Session not found") {
        sendError(response, 404, "session_not_found", "Session not found.");
        return;
      }
      sendError(response, 500, "internal_error", "Internal runner error.");
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.hostname, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `${localProtocol}://${opts.hostname}:${port}`;
  return {
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        unsubscribe();
        for (const stream of streams) stream.end();
        server.close((error) => error ? reject(error) : resolve());
      });
      await store.diagnostics.close();
    },
  };
}
