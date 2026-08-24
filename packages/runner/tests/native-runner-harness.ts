//! Shared process/event harness for the native-runner integration tests.
//! Extracted so each test file stays inside the repository source-size budget.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProvider } from "./native-runner-provider.ts";
export { requestBody, sse } from "./native-runner-provider.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = path.join(repositoryRoot, "target", "debug", process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner");

export const runnerPassword = "native-test-secret";

export function config(
  cwd: string,
  providerUrl: string,
  diagnosticLogPath: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    password: runnerPassword,
    taskId: "native-test-task",
    cwd,
    workspaceMode: "local",
    permissionMode: "normal",
    enabledTools: ["read", "ls", "find", "search", "write", "edit", "command"],
    diagnostics: { enabled: true, logPath: diagnosticLogPath, includeToolOutput: "stderr" },
    provider: {
      id: "company-endpoint",
      name: "Test Veil",
      baseURL: providerUrl,
      mode: "local",
      chatEndpointPath: "/api/engineering/chat",
      apiKey: "local",
      modelId: "test",
      capabilities: { parallelToolCalls: true, vision: false, reasoning: false },
    },
    ...overrides,
  };
}

export async function startRunner(
  cwd: string,
  providerUrl: string,
  diagnosticLogPath: string,
  overrides: Record<string, unknown> = {},
) {
  const child = spawn(binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The configuration is one line and stdin stays open for the session: the
  // runner reads its close as "the parent is gone" and shuts down.
  child.stdin.write(`${JSON.stringify(config(cwd, providerUrl, diagnosticLogPath, overrides))}\n`);
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner startup timed out: ${output}`)), 5_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/runner listening on\s+(http:\/\/\S+)/i);
      if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
  });
  const authorization = `Basic ${Buffer.from(`umbratic-runner:${runnerPassword}`).toString("base64")}`;
  const request = (route: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    return fetch(new URL(route, url), { ...init, headers });
  };
  return {
    child, url, request,
    // A runner that outlives its test holds target/debug/umbratic-runner.exe
    // open, and the next `cargo build` fails with "Access is denied" — which
    // reads as a stale binary rather than a leaked process, and has already
    // sent one debugging session down the wrong path. Never return while the
    // child might still be alive: escalate to SIGKILL if the polite signal is
    // not honoured promptly.
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function eventCollector(run: Awaited<ReturnType<typeof startRunner>>) {
  const response = await run.request("/event");
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const events: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate(event: Record<string, unknown>): boolean; resolve(event: Record<string, unknown>): void }> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
        if (data) {
          const event = JSON.parse(data) as Record<string, unknown>;
          events.push(event);
          for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  })();
  return {
    events,
    waitFor(predicate: (event: Record<string, unknown>) => boolean) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for runner event; observed ${events.map((event) => `${event.type}:${event.toolCallId ?? event.sessionId ?? ""}:${event.status ?? ""}:${event.errorMessage ?? ""}`).join(", ")}`)), 5_000);
        waiters.push({ predicate, resolve(event) { clearTimeout(timer); resolve(event); } });
      });
    },
    async close() { await reader.cancel(); await pump.catch(() => undefined); },
  };
}

export async function createSession(run: Awaited<ReturnType<typeof startRunner>>, conversationState?: unknown) {
  const response = await run.request("/session", {
    method: "POST",
    ...(conversationState === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationState }) }),
  });
  if (response.status !== 200) {
    throw new Error(`session create failed ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return response.json() as Promise<{ id: string }>;
}

export async function prompt(
  run: Awaited<ReturnType<typeof startRunner>>,
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return run.request(`/session/${id}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, ...extra }) });
}
