import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startProvider } from "./native-runner-provider.ts";
import { createSession, eventCollector, prompt, startRunner } from "./native-runner-harness.ts";

test("native runner sends the model name only when configured to", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-directives-"));
  const logPath = path.join(cwd, "diagnostics.jsonl");
  const provider = await startProvider();
  try {
  // Default configuration: the desktop confirmed nothing, so the field does not
  // travel. This is the body an older Veil has always received.
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
      const session = await createSession(configured);
      assert.equal((await prompt(configured, session.id, "hello there")).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
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
  assert.ok(directives.length > 0, "the configured run must reach the fake Veil");
  for (const body of directives) {
    assert.equal(body.model, "qwen3-32b", "a confirmed registry means every request names its model");
    assert.equal("thinking" in body, false, "thinking stays off the wire until its own feature is confirmed");
  }

  const thinkingRun = await startRunner(cwd, provider.url, logPath, {
    provider: {
      id: "company-endpoint",
      name: "Test Veil",
      baseURL: provider.url,
      mode: "local",
      chatEndpointPath: "/api/engineering/chat",
      apiKey: "local",
      modelId: "test",
      sendThinkingField: true,
      thinking: "off",
      capabilities: { parallelToolCalls: true, vision: false, reasoning: false },
    },
  });
  const thinkingStart = provider.requests.length;
  try {
    const events = await eventCollector(thinkingRun);
    try {
      const session = await createSession(thinkingRun);
      assert.equal((await prompt(thinkingRun, session.id, "hello there")).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
    } finally {
      await events.close();
    }
  } finally {
    await thinkingRun.close();
  }
  const thinkingBodies = provider.requests
    .slice(thinkingStart)
    .filter((entry) => entry.path?.endsWith("/chat"))
    .map((entry) => entry.body as Record<string, unknown>);
  assert.ok(thinkingBodies.length > 0, "the thinking-off run must reach the fake Veil");
  for (const body of thinkingBodies) {
    assert.equal(body.thinking, "off");
    assert.equal("model" in body, false);
  }
  assert.equal(provider.orientRequests.length, 0, "the runner must not call the classifier");
  assert.equal(
    JSON.stringify(provider.requests).includes("RAW_REASONING_MARKER"),
    false,
    "reasoning tokens never appear in chat request bodies",
  );

  const visibleRun = await startRunner(cwd, provider.url, logPath, {
    provider: {
      id: "company-endpoint",
      name: "Test Veil",
      baseURL: provider.url,
      mode: "local",
      chatEndpointPath: "/api/engineering/chat",
      apiKey: "local",
      modelId: "test",
      sendReasoningVisibleField: true,
      reasoningVisible: true,
      capabilities: { parallelToolCalls: true, vision: false, reasoning: true },
    },
  });
  const visibleStart = provider.requests.length;
  try {
    const events = await eventCollector(visibleRun);
    try {
      const session = await createSession(visibleRun);
      assert.equal((await prompt(visibleRun, session.id, "hello there")).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
      assert.equal(
        events.events.some((event) => event.type === "assistant.progress.delta" && String(event.text).includes("RAW_REASONING_MARKER")),
        true,
        "opted-in reasoning streams as Working narration",
      );
    } finally {
      await events.close();
    }
  } finally {
    await visibleRun.close();
  }
  const visibleBodies = provider.requests
    .slice(visibleStart)
    .filter((entry) => entry.path?.endsWith("/chat"))
    .map((entry) => entry.body as Record<string, unknown>);
  assert.ok(visibleBodies.length > 0, "the show-thinking run must reach the fake Veil");
  for (const body of visibleBodies) {
    assert.equal(body.reasoning_visible, true);
  }
  } finally {
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
