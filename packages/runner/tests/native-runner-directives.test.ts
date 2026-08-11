import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startProvider } from "./native-runner-provider.ts";
import { createSession, eventCollector, prompt, startRunner } from "./native-runner-harness.ts";

test("native runner sends the thinking directive and the model name only when configured to", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-directives-"));
  const logPath = path.join(cwd, "diagnostics.jsonl");
  const provider = await startProvider();

  // Default configuration: the desktop confirmed nothing, so neither field
  // travels. This is the body an older Veil has always received.
  const plain = await startRunner(cwd, provider.url, logPath);
  try {
    const events = await eventCollector(plain);
    try {
      const session = await createSession(plain);
      assert.equal((await prompt(plain, session.id, "hello there")).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
    } finally {
      await events.close();
    }
  } finally {
    await plain.close();
  }
  const beforeDirectives = provider.requests.filter((entry) => entry.path?.endsWith("/chat"));
  assert.ok(beforeDirectives.length > 0, "the default run must reach the fake Veil");
  for (const entry of beforeDirectives) {
    assert.equal("thinking" in entry.body, false, "no directive means no thinking field");
    assert.equal("model" in entry.body, false, "an unconfirmed feature means no model field");
  }

  const configured = await startRunner(cwd, provider.url, logPath, {
    provider: {
      id: "company-endpoint",
      name: "Test Veil",
      baseURL: provider.url,
      mode: "server",
      chatEndpointPath: "/api/engineering/chat",
      apiKey: "local",
      modelId: "qwen3-32b",
      sendModelField: true,
      capabilities: { parallelToolCalls: true, vision: false, reasoning: true },
    },
  });
  const start = provider.requests.length;
  try {
    const events = await eventCollector(configured);
    try {
      const fast = await createSession(configured);
      assert.equal((await prompt(configured, fast.id, "hello there", { reasoningMode: "fast" })).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === fast.id);

      const thinking = await createSession(configured);
      assert.equal((await prompt(configured, thinking.id, "hello there", { reasoningMode: "reasoning" })).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === thinking.id);

      const unknown = await createSession(configured);
      assert.equal((await prompt(configured, unknown.id, "hello there", { reasoningMode: "balanced" })).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === unknown.id);
    } finally {
      await events.close();
    }
  } finally {
    await configured.close();
  }

  const directives = provider.requests
    .slice(start)
    .filter((entry) => entry.path?.endsWith("/chat"))
    .map((entry) => entry.body as Record<string, unknown>);
  assert.equal(directives.length, 3);
  assert.deepEqual(directives.map((body) => body.thinking), ["off", "on", undefined]);
  for (const body of directives) {
    assert.equal(body.model, "qwen3-32b", "a confirmed registry means every request names its model");
  }
  assert.equal(
    JSON.stringify(provider.requests).includes("RAW_REASONING_MARKER"),
    false,
    "the directive controls whether the model thinks, never what leaves Veil",
  );

  await provider.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});
