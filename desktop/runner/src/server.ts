import * as http from "node:http";
import { URL } from "node:url";
import { nowIso, type AegisRunnerEvent } from "./events.js";
import { runTurn } from "./loop.js";
import type { InputPart } from "./session.js";
import { SessionStore } from "./session.js";

const localProtocol = "http";

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function sendJson(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendNoContent(response: http.ServerResponse) {
  response.writeHead(204);
  response.end();
}

function isAuthorized(request: http.IncomingMessage, password: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded === `aegis-runner:${password}`;
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

function writeSse(response: http.ServerResponse, event: AegisRunnerEvent) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
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
        response.writeHead(401, { "WWW-Authenticate": "Basic" });
        response.end("Unauthorized");
        return;
      }

      if (request.method === "GET" && url.pathname === "/event") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
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

      if (request.method === "POST" && url.pathname === "/session") {
        const session = store.create();
        sendJson(response, 200, { id: session.id });
        return;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const session = store.get(decodeURIComponent(promptMatch[1]));
        const body = await readJson(request);
        const parts = inputPartsFromBody(body);
        const system = typeof body.system === "string" ? body.system : "";
        if (system && !session.messages.some((message) => message.role === "system")) {
          session.messages.unshift({ role: "system", content: system });
        }
        void runTurn(session, parts, (event) => store.emit(event), (input) =>
          store.permissions.request({ taskId: session.taskId, ...input }),
        )
          .then(() => {
            store.emit({ type: "session.idle", taskId: session.taskId, sessionId: session.id, at: nowIso() });
          })
          .catch((error) => {
            store.emit({
              type: "runner.error",
              taskId: session.taskId,
              category: "loop",
              message: error instanceof Error ? error.message : String(error),
              at: nowIso(),
            });
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

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.hostname, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `${localProtocol}://${opts.hostname}:${port}`;
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        unsubscribe();
        for (const stream of streams) stream.end();
        server.close((error) => error ? reject(error) : resolve());
      }),
  };
}
