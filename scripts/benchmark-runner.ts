import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = positiveInteger(process.env.UMBRATIC_BENCH_SAMPLES, 20);
const roundTrips = positiveInteger(process.env.UMBRATIC_BENCH_ROUND_TRIPS, 100);
const promptTurns = positiveInteger(process.env.UMBRATIC_BENCH_PROMPT_TURNS, 20);
const label = process.env.UMBRATIC_BENCH_LABEL || "typescript";
const outputPath = process.env.UMBRATIC_BENCH_OUTPUT
  ? path.resolve(process.env.UMBRATIC_BENCH_OUTPUT)
  : null;
const runnerCommand = process.env.UMBRATIC_BENCH_RUNNER
  ? [path.resolve(process.env.UMBRATIC_BENCH_RUNNER)]
  : [path.join(root, "target", "release", process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner")];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    mean: Number(mean.toFixed(3)),
    median: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    min: Number(Math.min(...values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
  };
}

function authHeader(password) {
  return `Basic ${Buffer.from(`umbratic-runner:${password}`).toString("base64")}`;
}

function runnerConfig(cwd, providerBaseUrl) {
  return {
    taskId: "benchmark-task",
    cwd,
    contextLength: 64_000,
    maxResponseTokens: 4_096,
    protectedPromptReserveTokens: 4_096,
    workspaceMode: "local",
    modelBoundary: "managed",
    skills: [],
    permissionMode: "bypass",
    enabledTools: ["read"],
    diagnostics: false,
    provider: {
      id: "company-endpoint",
      name: "Benchmark Veil",
      baseURL: providerBaseUrl,
      chatEndpointPath: "/api/engineering/chat",
      apiKey: "benchmark-local-token",
      modelId: "benchmark-model",
    },
  };
}

function sseData(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function readJsonRequest(request) {
  let body = "";
  for await (const chunk of request) body += chunk.toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function startProvider() {
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readJsonRequest(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const encoded = JSON.stringify(messages);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      if (encoded.includes("BENCH_READ") && !encoded.includes("read: README.md (ok)")) {
        response.end(
          sseData({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "benchmark-read",
                  function: { name: "read", arguments: JSON.stringify({ filePath: "README.md", limit: 2 }) },
                }],
              },
            }],
          }) + "data: [DONE]\n\n",
        );
        return;
      }
      response.end(
        sseData({ choices: [{ delta: { content: "Benchmark response complete." } }] }) +
          sseData({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 } }) +
          "data: [DONE]\n\n",
      );
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark provider did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startRunner(cwd, providerBaseUrl) {
  const password = "benchmark-password";
  const [command, ...prefixArgs] = runnerCommand;
  const startedAt = performance.now();
  const child = spawn(command, [...prefixArgs, "serve", "--hostname=127.0.0.1", "--port=0", `--password=${password}`], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      UMBRATIC_RUNNER_CONFIG: JSON.stringify(runnerConfig(cwd, providerBaseUrl)),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runner startup timed out: ${output}`)), 10_000);
    const inspect = (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/umbratic runner listening on\s+(https?:\/\/[^\s]+)/i);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Runner exited during startup with ${code}: ${output}`));
    });
  });
  return {
    child,
    password,
    url,
    startupMs: performance.now() - startedAt,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function request(run, route, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", authHeader(run.password));
  const response = await fetch(new URL(route, run.url), { ...init, headers });
  if (!response.ok) throw new Error(`Runner request failed: ${response.status} ${await response.text()}`);
  return response;
}

async function rssBytes(pid) {
  const child = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for await (const chunk of child.stdout) output += chunk.toString("utf8");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) return null;
  const kib = Number(output.trim());
  return Number.isFinite(kib) ? kib * 1024 : null;
}

async function eventStream(run) {
  const response = await request(run, "/event");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waiters = new Map();
  let streamError = null;
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const row = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = row.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
          if (data) {
            const event = JSON.parse(data);
            if (event.type === "session.idle" && waiters.has(event.sessionId)) {
              waiters.get(event.sessionId).resolve(event);
              waiters.delete(event.sessionId);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      streamError = error;
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
    }
  })();
  return {
    waitForIdle(sessionId) {
      if (streamError) return Promise.reject(streamError);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(sessionId);
          reject(new Error(`Timed out waiting for session ${sessionId}`));
        }, 10_000);
        waiters.set(sessionId, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    async close() {
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  };
}

async function createSession(run) {
  const response = await request(run, "/session", { method: "POST" });
  return response.json();
}

async function benchmarkPrompt(run, events, prompt) {
  const session = await createSession(run);
  const idle = events.waitForIdle(session.id);
  const startedAt = performance.now();
  await request(run, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const event = await idle;
  if (event.summary?.status !== "completed") throw new Error(`Unexpected runner summary: ${JSON.stringify(event.summary)}`);
  return performance.now() - startedAt;
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
  }
  return total;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-benchmark-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "Umbratic benchmark fixture\nSecond source line\n", "utf8");
  const provider = await startProvider();
  try {
    const startupValues = [];
    for (let index = 0; index < samples; index += 1) {
      const run = await startRunner(workspace, provider.baseUrl);
      startupValues.push(run.startupMs);
      await run.close();
    }

    const run = await startRunner(workspace, provider.baseUrl);
    let events;
    try {
      const rssIdle = await rssBytes(run.child.pid);
      const sessionValues = [];
      for (let index = 0; index < roundTrips; index += 1) {
        const startedAt = performance.now();
        await createSession(run);
        sessionValues.push(performance.now() - startedAt);
      }

      events = await eventStream(run);
      const noToolValues = [];
      const readToolValues = [];
      for (let index = 0; index < promptTurns; index += 1) {
        noToolValues.push(await benchmarkPrompt(run, events, `BENCH_CHAT ${index}`));
        readToolValues.push(await benchmarkPrompt(run, events, `BENCH_READ ${index}`));
      }
      const rssWarm = await rssBytes(run.child.pid);
      const result = {
        schemaVersion: 1,
        label,
        measuredAt: new Date().toISOString(),
        host: { platform: process.platform, arch: process.arch, node: process.version },
        command: runnerCommand.map((part) => path.relative(root, part) || part),
        workloads: {
          coldStartMs: stats(startupValues),
          authenticatedSessionRoundTripMs: stats(sessionValues),
          streamedChatTurnMs: stats(noToolValues),
          streamedReadToolTurnMs: stats(readToolValues),
        },
        process: { idleRssBytes: rssIdle, warmRssBytes: rssWarm },
        artifacts: {
          runnerDistBytes: directoryBytes(path.join(root, "packages/runner/dist")),
          runnerNativeBytes: fs.statSync(runnerCommand[0]).size,
        },
        parameters: { startupSamples: samples, sessionRoundTrips: roundTrips, promptTurns },
      };
      const text = `${JSON.stringify(result, null, 2)}\n`;
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, text, "utf8");
      }
      process.stdout.write(text);
    } finally {
      await events?.close();
      await run.close();
    }
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

