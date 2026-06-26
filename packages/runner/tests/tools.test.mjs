import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const moduleCache = new Map();
const common = loadTypeScriptModule(new URL("../src/tools/common.ts", import.meta.url).pathname, { cache: moduleCache });
const { readTool } = loadTypeScriptModule(new URL("../src/tools/read.ts", import.meta.url).pathname, { cache: moduleCache });
const { writeTool } = loadTypeScriptModule(new URL("../src/tools/write.ts", import.meta.url).pathname, { cache: moduleCache });
const { editTool } = loadTypeScriptModule(new URL("../src/tools/edit.ts", import.meta.url).pathname, { cache: moduleCache });
const { searchTool } = loadTypeScriptModule(new URL("../src/tools/search.ts", import.meta.url).pathname, { cache: moduleCache });
const { commandTool } = loadTypeScriptModule(new URL("../src/tools/command.ts", import.meta.url).pathname, { cache: moduleCache });
const { debuggerTool } = loadTypeScriptModule(new URL("../src/tools/debugger.ts", import.meta.url).pathname, { cache: moduleCache });
const { enabledToolSpecs, runTool } = loadTypeScriptModule(new URL("../src/tools/index.ts", import.meta.url).pathname, { cache: moduleCache });
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tools-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "skip-me"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "Intro\nTarget phrase\nFinal\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 41;\n", "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "skip-me", "ignored.js"), "Target phrase\n", "utf8");
  return root;
}

function context(cwd, options = {}) {
  const permissions = [];
  const outputs = [];
  return {
    ctx: {
      taskId: "task-1",
      cwd,
      permissionMode: options.permissionMode ?? "normal",
      enabledTools: options.enabledTools ?? ["read", "write", "edit", "search", "command", "debugger"],
      async askPermission(input) {
        permissions.push(input);
        return options.decision ?? "allow";
      },
      emitToolOutput(toolCallId, stream, text) {
        outputs.push({ toolCallId, stream, text });
      },
    },
    permissions,
    outputs,
  };
}

test("resolveWorkspacePath accepts root-prefixed relative paths and rejects escapes and blocked files", () => {
  const root = workspace();
  const prefixed = path.join(path.basename(root), "README.md");
  const resolved = common.resolveWorkspacePath(root, prefixed);
  assert.equal(resolved.relative, "README.md");

  assert.throws(() => common.resolveWorkspacePath(root, "../outside.txt"), /outside workspace/);
  assert.throws(() => common.resolveWorkspacePath(root, ".env"), /blocked path/);
});

test("readTool reads file ranges and lists directories while skipping generated entries", async () => {
  const root = workspace();
  const { ctx } = context(root);

  const file = await readTool(ctx, { filePath: "README.md", offset: 2, limit: 1 });
  assert.equal(file.title, "README.md");
  assert.equal(file.output, "2: Target phrase");

  const listing = await readTool(ctx, { filePath: ".", limit: 10 });
  assert.match(listing.output, /README\.md/);
  assert.match(listing.output, /src\//);
  assert.doesNotMatch(listing.output, /node_modules/);
});

test("writeTool and editTool enforce permission and make real workspace changes", async () => {
  const root = workspace();
  const denied = context(root, { decision: "deny" });
  await assert.rejects(() => writeTool(denied.ctx, { filePath: "notes/todo.md", content: "ship it" }), /denied/);
  assert.equal(fs.existsSync(path.join(root, "notes", "todo.md")), false);

  const allowed = context(root);
  const written = await writeTool(allowed.ctx, { filePath: "notes/todo.md", content: "ship it" });
  assert.equal(written.output, "Wrote file successfully.");
  assert.equal(fs.readFileSync(path.join(root, "notes", "todo.md"), "utf8"), "ship it");
  assert.deepEqual(allowed.permissions.map((request) => request.summary), ["write notes/todo.md"]);

  const edited = await editTool(allowed.ctx, { filePath: "src/app.ts", oldText: "41", newText: "42" });
  assert.equal(edited.output, "Edited file successfully.");
  assert.match(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8"), /42/);
  await assert.rejects(() => editTool(allowed.ctx, { filePath: "src/app.ts", oldText: "missing", newText: "x" }), /not found/);
});

test("searchTool finds real path and content matches without returning generated directories", async () => {
  const root = workspace();
  const { ctx } = context(root);

  const pathResult = await searchTool(ctx, { query: "app.ts", limit: 5 });
  assert.match(pathResult.output, /src\/app\.ts: path/);

  const contentResult = await searchTool(ctx, { query: "Target phrase", limit: 10 });
  assert.match(contentResult.output, /README\.md/);
  assert.doesNotMatch(contentResult.output, /node_modules/);

  await assert.rejects(() => searchTool(ctx, { query: "   " }), /requires query/);
});

test("commandTool blocks unsafe commands, asks permission for safe commands, and redacts emitted output", async () => {
  const root = workspace();
  const blocked = context(root);
  await assert.rejects(() => commandTool(blocked.ctx, { command: "curl https://example.test" }, "tool-1"), /blocked by policy/);
  assert.equal(blocked.permissions.length, 0);

  const allowed = context(root);
  const command = `node -e "console.log('runner-ok'); console.error('token=abcdefghijklmnopqrstuvwxyz')"`;
  const result = await commandTool(allowed.ctx, { command }, "tool-2");

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /runner-ok/);
  assert.doesNotMatch(result.output, /abcdefghijklmnopqrstuvwxyz/);
  assert.equal(allowed.permissions.length, 1);
  assert.equal(allowed.outputs.some((output) => output.stream === "stdout" && output.text.includes("runner-ok")), true);
});

test("debuggerTool validates workspace executable input before requiring optional debuggers", async () => {
  const root = workspace();
  const { ctx } = context(root);

  await assert.rejects(() => debuggerTool(ctx, { executablePath: "missing.exe" }, "debug-1"), /was not found/);
});

test("runTool gates disabled tools, emits lifecycle events, and forwards tool output", async () => {
  const root = workspace();
  const events = [];
  const readCtx = context(root).ctx;
  const result = await runTool(readCtx, (event) => events.push(event), {
    id: "call-read",
    name: "read",
    arguments: JSON.stringify({ filePath: "README.md", limit: 1 }),
  });

  assert.equal(result.title, "README.md");
  assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(events[0].summary, "read README.md --limit 1");

  const disabled = context(root, { enabledTools: ["read"] });
  await assert.rejects(
    () => runTool(disabled.ctx, (event) => events.push(event), { id: "call-write", name: "write", arguments: { filePath: "x.txt", content: "x" } }),
    /disabled/,
  );
});

test("enabledToolSpecs returns only configured tool definitions in canonical order", () => {
  const specs = enabledToolSpecs(["command", "read"]);
  assert.deepEqual(plain(specs.map((spec) => spec.function.name)), ["read", "command"]);
});
