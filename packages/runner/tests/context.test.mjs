import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const cache = new Map();
const { compressToolResult } = loadTypeScriptModule(new URL("../src/context/contentRouter.ts", import.meta.url).pathname, { cache });
const { contextHash, SessionContextStore } = loadTypeScriptModule(new URL("../src/context/sessionContextStore.ts", import.meta.url).pathname, { cache });
const { enabledModelToolSpecs, runTool } = loadTypeScriptModule(new URL("../src/tools/index.ts", import.meta.url).pathname, { cache });
const plain = (value) => JSON.parse(JSON.stringify(value));

function repeatedLines(prefix, count, suffix = "") {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index} ${suffix}`).join("\n");
}

function context(store) {
  return {
    taskId: "task-1",
    cwd: process.cwd(),
    permissionMode: "normal",
    enabledTools: ["read", "write", "edit", "search", "command"],
    contextStore: store,
    async askPermission() {
      throw new Error("retrieve_context should not ask permission");
    },
    emitToolOutput() {
      throw new Error("retrieve_context should not emit raw tool output");
    },
  };
}

test("small context output passes through without storing originals", () => {
  const store = new SessionContextStore();

  const result = compressToolResult({
    toolName: "read",
    toolCallId: "call-small",
    title: "README.md",
    output: "1: short output",
    status: "success",
    contextStore: store,
  });

  assert.equal(result.modified, false);
  assert.equal(result.strategy, "passthrough");
  assert.equal(result.output, "1: short output");
  assert.equal(store.hasEntries(), false);
});

test("large command output compresses with a marker and retrieve_context returns a bounded window", async () => {
  const store = new SessionContextStore();
  const commandOutput = [
    "exitCode=1",
    repeatedLines("setup line", 1200, "x".repeat(40)),
    "ERROR failing test: should preserve failures",
    repeatedLines("tail line", 1200, "x".repeat(40)),
  ].join("\n");

  const compressed = compressToolResult({
    toolName: "command",
    toolCallId: "call-command",
    title: "npm test",
    output: commandOutput,
    status: "runtime_error",
    contextStore: store,
  });

  assert.equal(compressed.modified, true);
  assert.equal(compressed.strategy, "log_errors_tail");
  assert.match(compressed.output, /<<umbratic-context:/);
  assert.match(compressed.output, /ERROR failing test/);
  assert.ok(compressed.markerHash);
  assert.equal(store.hasEntries(), true);

  const events = [];
  const retrieved = await runTool(context(store), (event) => events.push(event), {
    id: "call-retrieve",
    name: "retrieve_context",
    arguments: { hash: compressed.markerHash, offset: 0, limit: 180 },
  });

  assert.equal(retrieved.status, "success");
  assert.match(retrieved.output, new RegExp(`Retrieved context ${compressed.markerHash}`));
  assert.match(retrieved.output, /exitCode=1/);
  assert.match(retrieved.output, /Next offset:/);
  const retrievedEvent = events.find((event) => event.type === "context.retrieved");
  assert.equal(retrievedEvent.hash, compressed.markerHash);
  assert.equal(retrievedEvent.bytesShown <= 180, true);
});

test("retrieve_context is hidden until context exists and validates unknown hashes", async () => {
  const store = new SessionContextStore();

  assert.deepEqual(plain(enabledModelToolSpecs(["read"]).map((spec) => spec.function.name)), ["read"]);
  assert.deepEqual(plain(enabledModelToolSpecs(["read"], { includeContextRetrieval: true }).map((spec) => spec.function.name)), [
    "read",
    "retrieve_context",
  ]);

  await assert.rejects(
    () => runTool(context(store), () => undefined, {
      id: "missing",
      name: "retrieve_context",
      arguments: { hash: "does-not-exist" },
    }),
    /No stored context found/,
  );
});

test("json array compression preserves first last and error-shaped items", () => {
  const store = new SessionContextStore();
  const rows = Array.from({ length: 260 }, (_, index) => ({
    id: `row-${index}`,
    status: index === 130 ? "failed" : "ok",
    detail: "x".repeat(90),
  }));

  const compressed = compressToolResult({
    toolName: "command",
    toolCallId: "call-json",
    title: "json output",
    output: JSON.stringify(rows),
    status: "success",
    contextStore: store,
  });

  assert.equal(compressed.modified, true);
  assert.equal(compressed.strategy, "json_array_sample");
  assert.match(compressed.output, /row-0/);
  assert.match(compressed.output, /row-130/);
  assert.match(compressed.output, /failed/);
  assert.match(compressed.output, /row-259/);
});

test("directory compression keeps listing status and groups entries", () => {
  const store = new SessionContextStore();
  const entries = [
    ...Array.from({ length: 700 }, (_, index) => `src/module-${index}/deep/path/file-with-a-long-name.ts`),
    ...Array.from({ length: 240 }, (_, index) => `tests/module-${index}.test.ts`),
  ].join("\n");
  const output = [
    "Directory: .",
    "Depth: 3",
    "Entries shown: 1-940 of 1200",
    "Listing status: partial; continue with offset 941",
    "Entries:",
    entries,
  ].join("\n");

  const compressed = compressToolResult({
    toolName: "read",
    toolCallId: "call-dir",
    title: ".",
    output,
    status: "success",
    contextStore: store,
  });

  assert.equal(compressed.modified, true);
  assert.equal(compressed.strategy, "directory_grouped");
  assert.match(compressed.output, /Listing status: partial; continue with offset 941/);
  assert.match(compressed.output, /Grouped entries:/);
  assert.match(compressed.output, /src: 700/);
});

test("session context store evicts oldest entries and keeps byte stats", () => {
  const store = new SessionContextStore();
  for (let index = 0; index < 40; index += 1) {
    store.store({
      toolCallId: `call-${index}`,
      toolName: "read",
      title: `file-${index}.txt`,
      original: `original ${index}`,
      compressed: `compressed ${index}`,
      kind: "plain_text",
      strategy: "text_head_tail",
      originalBytes: 0,
      compressedBytes: 0,
    });
  }

  assert.equal(store.stats().entries, 32);
  assert.equal(store.stats().storedBytes > 0, true);
  assert.equal(store.retrieve(contextHash("original 0").hash), null);
  assert.notEqual(store.retrieve(contextHash("original 39").hash), null);
});
