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
const { parseSearchQuery } = loadTypeScriptModule(new URL("../src/tools/searchQuery.ts", import.meta.url).pathname, { cache: moduleCache });
const { getWorkspaceIndex } = loadTypeScriptModule(new URL("../src/tools/workspaceIndex.ts", import.meta.url).pathname, { cache: moduleCache });
const { commandTool } = loadTypeScriptModule(new URL("../src/tools/command.ts", import.meta.url).pathname, { cache: moduleCache });
const {
  enabledModelToolSpecs,
  enabledToolSpecs,
  normalizeModelToolSpec,
  runTool,
  schemaHasAdapterHostileShapes,
  toolSpecs,
} = loadTypeScriptModule(new URL("../src/tools/index.ts", import.meta.url).pathname, { cache: moduleCache });
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tools-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "skip-me"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "Intro\nTarget phrase\nFinal\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 41;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "components", "Button.ts"), "export const Button = 'ok';\n", "utf8");
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
      enabledTools: options.enabledTools ?? ["read", "write", "edit", "search", "command"],
      skills: options.skills ?? [],
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

function outputLines(result) {
  return result.output.split(/\r?\n/).filter(Boolean);
}

test("resolveWorkspacePath accepts root-prefixed relative paths and rejects escapes and blocked files", () => {
  const root = workspace();
  const prefixed = path.join(path.basename(root), "README.md");
  const resolved = common.resolveWorkspacePath(root, prefixed);
  assert.equal(resolved.relative, "README.md");
  assert.equal(common.resolveWorkspacePath(root, "/workspace/README.md").relative, "README.md");

  assert.throws(() => common.resolveWorkspacePath(root, "../outside.txt"), /outside workspace/);
  assert.throws(() => common.resolveWorkspacePath(root, "/workspace/../outside.txt"), /outside workspace/);
  assert.throws(() => common.resolveWorkspacePath(root, ".env"), /blocked path/);
});

test("readTool reads file ranges and lists directories while skipping generated entries", async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "empty-folder"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested-repo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".DS_Store"), "finder metadata\n", "utf8");
  fs.writeFileSync(path.join(root, "Credentials.md"), "private\n", "utf8");
  const { ctx } = context(root);

  const file = await readTool(ctx, { filePath: "README.md", offset: 2, limit: 1 });
  assert.equal(file.title, "README.md");
  assert.equal(file.output, "2: Target phrase");

  const listing = await readTool(ctx, { filePath: ".", limit: 10 });
  assert.match(listing.output, /^Directory: \.\nDepth: 1\nEntries shown: 1-\d+ of \d+\nListing status: complete\nEntries:/);
  assert.match(listing.output, /README\.md/);
  assert.match(listing.output, /empty-folder\//);
  assert.match(listing.output, /nested-repo\//);
  assert.match(listing.output, /src\//);
  assert.doesNotMatch(listing.output, /Button\.ts/);
  assert.doesNotMatch(listing.output, /\.DS_Store/);
  assert.doesNotMatch(listing.output, /Credentials\.md/);
  assert.doesNotMatch(listing.output, /node_modules/);

  const partial = await readTool(ctx, { filePath: ".", limit: 1 });
  assert.match(partial.output, /Listing status: partial; continue with offset 2/);

  const recursive = await readTool(ctx, { filePath: ".", depth: 3, limit: 20 });
  assert.match(recursive.output, /src\/components\//);
  assert.match(recursive.output, /src\/components\/Button\.ts/);
  assert.doesNotMatch(recursive.output, /node_modules/);
});

test("writeTool and editTool enforce permission and make real workspace changes", async () => {
  const root = workspace();
  const denied = context(root, { decision: "deny" });
  await assert.rejects(() => writeTool(denied.ctx, { filePath: "notes/todo.md", content: "ship it" }), /denied/);
  assert.equal(fs.existsSync(path.join(root, "notes", "todo.md")), false);

  const allowed = context(root);
  const written = await writeTool(allowed.ctx, { filePath: "notes/todo.md", content: "ship it" });
  assert.equal(written.output, "Wrote file successfully.");
  assert.equal(written.status, "success");
  assert.equal(fs.readFileSync(path.join(root, "notes", "todo.md"), "utf8"), "ship it");
  assert.deepEqual(allowed.permissions.map((request) => request.summary), ["write notes/todo.md"]);

  const edited = await editTool(allowed.ctx, { filePath: "src/app.ts", oldText: "41", newText: "42" });
  assert.equal(edited.output, "Edited file successfully.");
  assert.equal(edited.status, "success");
  assert.match(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8"), /42/);
  await assert.rejects(() => editTool(allowed.ctx, { filePath: "src/app.ts", oldText: "missing", newText: "x" }), /not found/);
});

test("editTool patch mode applies multi-file add update and delete after one permission", async () => {
  const root = workspace();
  const allowed = context(root);
  const patch = [
    "*** Begin Patch",
    "*** Add File: notes/plan.md",
    "+ship",
    "+verify",
    "*** Update File: src/app.ts",
    "@@",
    "-export const answer = 41;",
    "+export const answer = 42;",
    "*** Delete File: README.md",
    "*** End Patch",
  ].join("\n");

  const result = await editTool(allowed.ctx, { mode: "patch", patch });

  assert.equal(result.status, "success");
  assert.equal(result.title, "patch");
  assert.match(result.output, /Patched 3 files successfully/);
  assert.match(result.output, /added notes\/plan\.md/);
  assert.match(result.output, /modified src\/app\.ts/);
  assert.match(result.output, /deleted README\.md/);
  assert.equal(fs.readFileSync(path.join(root, "notes", "plan.md"), "utf8"), "ship\nverify");
  assert.equal(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(fs.existsSync(path.join(root, "README.md")), false);
  assert.deepEqual(allowed.permissions.map((request) => request.summary), [
    "patch 3 files: notes/plan.md, src/app.ts, README.md",
  ]);
});

test("editTool patch mode supports update plus move", async () => {
  const root = workspace();
  const allowed = context(root);
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "*** Move to: src/answer.ts",
    "@@",
    "-export const answer = 41;",
    "+export const answer = 43;",
    "*** End Patch",
  ].join("\n");

  const result = await editTool(allowed.ctx, { mode: "patch", patch });

  assert.equal(result.status, "success");
  assert.match(result.output, /renamed src\/app\.ts -> src\/answer\.ts/);
  assert.equal(fs.existsSync(path.join(root, "src", "app.ts")), false);
  assert.equal(fs.readFileSync(path.join(root, "src", "answer.ts"), "utf8"), "export const answer = 43;\n");
});

test("editTool patch mode validates grammar and hunks before permission or writes", async () => {
  const root = workspace();
  const invalid = context(root);
  const patch = [
    "*** Begin Patch",
    "*** Add File: notes/new.md",
    "+created only if the whole patch validates",
    "*** Update File: src/app.ts",
    "@@",
    "-export const answer = 999;",
    "+export const answer = 1000;",
    "*** End Patch",
  ].join("\n");

  await assert.rejects(() => editTool(invalid.ctx, { mode: "patch", patch }), /hunk was not found/);
  assert.equal(fs.existsSync(path.join(root, "notes", "new.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8"), "export const answer = 41;\n");
  assert.equal(invalid.permissions.length, 0);

  await assert.rejects(() => editTool(invalid.ctx, { mode: "patch", patch: "*** Add File: x.txt\n+missing envelope" }), /Begin Patch/);
  await assert.rejects(
    () => editTool(invalid.ctx, { mode: "patch", patch: "*** Begin Patch\n*** Add File: .env\n+SECRET=value\n*** End Patch" }),
    /blocked path/,
  );
  await assert.rejects(
    () => editTool(invalid.ctx, { mode: "patch", patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+escape\n*** End Patch" }),
    /outside workspace/,
  );
  assert.equal(invalid.permissions.length, 0);
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

test("workspace index excludes generated and blocked paths", () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".umbratic", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, ".venv"), { recursive: true });
  fs.writeFileSync(path.join(root, ".DS_Store"), "skip\n", "utf8");
  fs.writeFileSync(path.join(root, ".git", "ignored.txt"), "skip\n", "utf8");
  fs.writeFileSync(path.join(root, ".umbratic", "runtime", "ignored.txt"), "skip\n", "utf8");
  fs.writeFileSync(path.join(root, ".venv", "ignored.py"), "skip\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=value\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "secret-note.txt"), "skip\n", "utf8");

  const relatives = getWorkspaceIndex(root).files.map((file) => file.relative);

  assert.match(relatives.join("\n"), /README\.md/);
  assert.equal(relatives.some((relative) => relative.startsWith("node_modules/")), false);
  assert.equal(relatives.some((relative) => relative.startsWith(".git/")), false);
  assert.equal(relatives.some((relative) => relative.startsWith(".umbratic/")), false);
  assert.equal(relatives.some((relative) => relative.startsWith(".venv/")), false);
  assert.equal(relatives.includes(".DS_Store"), false);
  assert.equal(relatives.some((relative) => relative.includes("secret")), false);
  assert.equal(relatives.includes(".env"), false);
});

test("parseSearchQuery supports constraints, exclusions, globs, smart case, and locations", () => {
  const parsed = parseSearchQuery("src/ src/**/*.tsx !test/ !*.min.js Button service.ts:42:7");

  assert.deepEqual(plain(parsed.includeDirs), ["src/"]);
  assert.deepEqual(plain(parsed.includeGlobs), ["src/**/*.tsx"]);
  assert.deepEqual(plain(parsed.excludeDirs), ["test/"]);
  assert.deepEqual(plain(parsed.excludeGlobs), ["*.min.js"]);
  assert.deepEqual(plain(parsed.terms), ["Button"]);
  assert.deepEqual(plain(parsed.location), { pathQuery: "service.ts", line: 42, column: 7 });
  assert.equal(parsed.smartCase, true);
  assert.equal(parseSearchQuery("button component").smartCase, false);
});

test("searchTool ranks exact path matches, tolerates typos, narrows tokens, and honors constraints", async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "Button.md"), "button docs\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "components", "Button.test.ts"), "export const ButtonTest = true;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "test", "TestButton.ts"), "export const TestButton = true;\n", "utf8");
  const { ctx } = context(root);

  const exact = await searchTool(ctx, { query: "Button.ts", limit: 5 });
  assert.equal(outputLines(exact)[0], "src/components/Button.ts: path");

  const typo = await searchTool(ctx, { query: "Buton.ts", limit: 5 });
  assert.match(typo.output, /src\/components\/Button\.ts: path/);

  const narrowed = await searchTool(ctx, { query: "src Button", limit: 10 });
  assert.match(narrowed.output, /src\/components\/Button\.ts: path/);
  assert.doesNotMatch(narrowed.output, /docs\/Button\.md/);

  const scoped = await searchTool(ctx, { query: "src/ button", limit: 10 });
  assert.match(scoped.output, /src\/components\/Button\.ts: path/);
  assert.doesNotMatch(scoped.output, /docs\/Button\.md/);

  const excluded = await searchTool(ctx, { query: "!test/ button", limit: 10 });
  assert.match(excluded.output, /src\/components\/Button\.ts: path/);
  assert.doesNotMatch(excluded.output, /src\/test\/TestButton\.ts/);
});

test("content search skips generated and blocked paths, ranks definitions, and respects limit", async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".umbratic", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, ".venv"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "skip-me", "hidden.js"), "HiddenNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, ".git", "hidden.txt"), "HiddenNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, ".umbratic", "runtime", "hidden.txt"), "HiddenNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, ".venv", "hidden.py"), "HiddenNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "HiddenNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "defs.ts"), "function Widget() {\n  return true;\n}\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "imports.ts"), "import { Widget } from './defs';\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "repeat-a.txt"), "LimitNeedle\nLimitNeedle\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "repeat-b.txt"), "LimitNeedle\n", "utf8");
  const { ctx } = context(root);

  const skipped = await searchTool(ctx, { query: "HiddenNeedle", limit: 10 });
  assert.equal(skipped.output, "No matches.");

  const ranked = await searchTool(ctx, { query: "Widget", limit: 5 });
  assert.equal(outputLines(ranked)[0], "src/defs.ts:1: content");
  assert.match(ranked.output, /src\/imports\.ts:1: content/);

  const limited = await searchTool(ctx, { query: "LimitNeedle", limit: 1 });
  assert.equal(outputLines(limited).length, 1);
});

test("readTool records recent reads for search ranking and supports line suffix offsets", async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "z"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "config.ts"), "export const config = 'a';\n", "utf8");
  fs.writeFileSync(path.join(root, "z", "config.ts"), "export const config = 'z';\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "lines.ts"), Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");
  const { ctx } = context(root);

  await readTool(ctx, { filePath: "z/config.ts", limit: 1 });
  const ranked = await searchTool(ctx, { query: "config.ts", limit: 2 });
  assert.equal(outputLines(ranked)[0], "z/config.ts: path");

  const located = await readTool(ctx, { filePath: "src/lines.ts:10", limit: 3 });
  assert.equal(located.title, "src/lines.ts");
  assert.equal(located.output, "5: line 5\n6: line 6\n7: line 7");
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
  assert.equal(result.status, "success");
  assert.match(result.output, /runner-ok/);
  assert.doesNotMatch(result.output, /abcdefghijklmnopqrstuvwxyz/);
  assert.equal(allowed.permissions.length, 1);
  assert.equal(allowed.outputs.some((output) => output.stream === "stdout" && output.text.includes("runner-ok")), true);
});

test("runTool allows bare Python commands to reach normal permission handling", async () => {
  const root = workspace();
  const barePython = context(root, { decision: "deny" });

  await assert.rejects(
    () => runTool(barePython.ctx, () => undefined, {
      id: "tool-bare-python",
      name: "command",
      arguments: { command: "python script.py" },
    }),
    /Command denied/,
  );
  assert.equal(barePython.permissions.length, 1);
  assert.equal(barePython.permissions[0].summary, "python script.py");
});

test("commandTool preserves streamed newlines between output chunks", async () => {
  const root = workspace();
  const allowed = context(root);
  const command = `node -e "process.stdout.write('line-1\\n'); setTimeout(() => process.stdout.write('line-2\\n'), 50)"`;
  const result = await commandTool(allowed.ctx, { command }, "tool-stream-lines");

  assert.equal(result.status, "success");
  assert.equal(
    allowed.outputs.filter((output) => output.stream === "stdout").map((output) => output.text).join(""),
    "line-1\nline-2\n",
  );
  assert.match(result.output, /line-1\nline-2/);
});

test("commandTool terminates commands that exceed their bounded timeout", async () => {
  const root = workspace();
  const allowed = context(root);
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
  const startedAt = Date.now();
  const result = await commandTool(allowed.ctx, { command, timeoutMs: 100 }, "tool-timeout");

  assert.equal(result.status, "timeout");
  assert.equal(result.errorCode, "process_timeout");
  assert.match(result.errorMessage, /timed out after 100 ms/);
  assert.ok(Date.now() - startedAt < 3000);
});

test("commandTool reports non-zero command exits as structured runtime errors", async () => {
  const root = workspace();
  const allowed = context(root);
  const result = await commandTool(allowed.ctx, { command: "exit 7" }, "tool-exit");

  assert.equal(result.exitCode, 7);
  assert.equal(result.status, "runtime_error");
  assert.equal(result.errorCode, "command_exit_nonzero");
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
  assert.equal(result.status, "success");
  const lifecycle = events.filter((event) => event.type === "tool.requested" || event.type === "tool.finished");
  const stages = events.filter((event) => event.type === "tool.policy.stage");
  assert.deepEqual(lifecycle.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.deepEqual(stages.map((event) => event.stage), [
    "normalize_tool_call",
    "normalize_tool_call",
    "resolve_workspace_paths",
    "classify_action",
    "apply_static_deny_rules",
    "request_permission",
    "execute_backend",
    "execute_backend",
    "redact_and_summarize_output",
    "emit_audit_telemetry",
  ]);
  assert.equal(lifecycle[0].summary, "read README.md --limit 1");
  assert.equal(lifecycle[1].status, "success");
  assert.equal(lifecycle[1].exitCode, 0);
  assert.equal(typeof lifecycle[1].durationMs, "number");
  assert.match(lifecycle[1].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(lifecycle[1].finishedAt, /^\d{4}-\d{2}-\d{2}T/);

  const disabled = context(root, { enabledTools: ["read"] });
  const disabledEvents = [];
  await assert.rejects(
    () => runTool(disabled.ctx, (event) => disabledEvents.push(event), { id: "call-write", name: "write", arguments: { filePath: "x.txt", content: "x" } }),
    /disabled/,
  );
  const disabledLifecycle = disabledEvents.filter((event) => event.type === "tool.requested" || event.type === "tool.finished");
  const disabledBlocked = disabledEvents.find((event) => event.type === "tool.policy.stage" && event.stage === "apply_static_deny_rules" && event.outcome === "blocked");
  assert.deepEqual(disabledLifecycle.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(disabledBlocked.code, "tool_disabled");
  assert.equal(disabledLifecycle[1].status, "validation_error");
  assert.equal(disabledLifecycle[1].errorCode, "tool_disabled");
});

test("runTool applies edit patch mode and emits patch summaries", async () => {
  const root = workspace();
  const events = [];
  const toolContext = context(root);
  const patch = [
    "*** Begin Patch",
    "*** Add File: notes/run-tool.md",
    "+created through runTool",
    "*** End Patch",
  ].join("\n");

  const result = await runTool(toolContext.ctx, (event) => events.push(event), {
    id: "call-patch",
    name: "edit",
    arguments: { mode: "patch", patch },
  });

  assert.equal(result.status, "success");
  const requested = events.find((event) => event.type === "tool.requested");
  assert.equal(requested.summary, "edit patch");
  assert.equal(requested.commandClass, "edit");
  assert.equal(toolContext.outputs.some((output) => output.toolCallId === "call-patch" && output.text.includes("added notes/run-tool.md")), true);
  assert.equal(fs.readFileSync(path.join(root, "notes", "run-tool.md"), "utf8"), "created through runTool");
});

test("runTool canonicalizes case-only model tool name variations", async () => {
  const root = workspace();
  const events = [];
  const toolContext = context(root);

  const result = await runTool(toolContext.ctx, (event) => events.push(event), {
    id: "call-edit-cased",
    name: "Edit",
    arguments: {
      mode: "replace",
      filePath: "README.md",
      oldText: "Target phrase",
      newText: "Updated phrase",
    },
  });

  assert.equal(result.status, "success");
  assert.equal(events.find((event) => event.type === "tool.requested").toolKind, "edit");
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "Intro\nUpdated phrase\nFinal\n");
});

test("runTool marks malformed model tool arguments as validation errors", async () => {
  const root = workspace();
  const events = [];
  await assert.rejects(
    () => runTool(context(root).ctx, (event) => events.push(event), { id: "bad-args", name: "read", arguments: "{bad json" }),
    /valid JSON/,
  );

  const lifecycle = events.filter((event) => event.type === "tool.requested" || event.type === "tool.finished");
  const normalizeBlocked = events.find((event) => event.type === "tool.policy.stage" && event.stage === "normalize_tool_call" && event.outcome === "blocked");
  assert.deepEqual(lifecycle.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(normalizeBlocked.code, "invalid_arguments");
  assert.equal(lifecycle[1].status, "validation_error");
  assert.equal(lifecycle[1].errorCode, "invalid_arguments");
});

test("enabledToolSpecs returns only configured tool definitions in canonical order", () => {
  const specs = enabledToolSpecs(["command", "read"]);
  assert.deepEqual(plain(specs.map((spec) => spec.function.name)), ["read", "command"]);
});

test("enabledModelToolSpecs returns provider-facing schemas without adapter-hostile shapes", () => {
  const specs = enabledModelToolSpecs(["command", "read", "edit"]);
  assert.deepEqual(plain(specs.map((spec) => spec.function.name)), ["read", "edit", "command"]);
  for (const spec of specs) {
    assert.equal(schemaHasAdapterHostileShapes(spec.function.parameters), false, spec.function.name);
    assert.equal(spec.function.parameters.type, "object", spec.function.name);
    assert.equal(Array.isArray(spec.function.parameters.required), true, spec.function.name);
  }
  const command = specs.find((spec) => spec.function.name === "command");
  assert.equal(command.function.parameters.properties.timeoutMs.type, "number");
  assert.match(command.function.description, /PowerShell/);
  assert.match(command.function.description, /uv run python/);
  assert.match(command.function.description, /Bare python, python3, and py are allowed/);
  assert.match(command.function.description, /retry it with uv/);
});

test("read_skill reads only enabled skill instructions and their bounded resources", async () => {
  const root = workspace();
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-enabled-skill-"));
  const instructionPath = path.join(skillRoot, "SKILL.md");
  fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
  fs.writeFileSync(instructionPath, "# Review\n\nRead references/checklist.md.\n", "utf8");
  fs.writeFileSync(path.join(skillRoot, "references", "checklist.md"), "Check facts and risks.\n", "utf8");
  const toolContext = context(root, {
    skills: [{ id: "review", name: "Review", description: "Use for reviews.", source: "local", instructionPath }],
  });

  const main = await runTool(toolContext.ctx, () => undefined, {
    id: "call-skill",
    name: "read_skill",
    arguments: { skillId: "review" },
  });
  assert.match(main.output, /Read status: complete/);
  assert.match(main.output, /Read references\/checklist\.md/);
  assert.equal(toolContext.permissions.length, 0);

  const resource = await runTool(toolContext.ctx, () => undefined, {
    id: "call-resource",
    name: "read_skill",
    arguments: { skillId: "review", resource: "references/checklist.md" },
  });
  assert.match(resource.output, /Check facts and risks/);
  await assert.rejects(
    () => runTool(toolContext.ctx, () => undefined, {
      id: "call-escape",
      name: "read_skill",
      arguments: { skillId: "review", resource: "../outside.md" },
    }),
    /outside its skill folder/,
  );
  await assert.rejects(
    () => runTool(context(root).ctx, () => undefined, {
      id: "call-disabled-skill",
      name: "read_skill",
      arguments: { skillId: "review" },
    }),
    /not enabled/,
  );
});

test("enabledModelToolSpecs adds read_skill only when enabled skills exist", () => {
  assert.deepEqual(plain(enabledModelToolSpecs(["read"], { includeSkillReader: true }).map((spec) => spec.function.name)), ["read", "read_skill"]);
  assert.deepEqual(plain(enabledModelToolSpecs(["read"]).map((spec) => spec.function.name)), ["read"]);
});

test("read_skill reports continuation offsets until the complete skill has been read", async () => {
  const root = workspace();
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-long-skill-"));
  const instructionPath = path.join(skillRoot, "SKILL.md");
  fs.writeFileSync(instructionPath, `# Long skill\n\n${"x".repeat(9000)}\n`, "utf8");
  const { ctx } = context(root, {
    skills: [{ id: "long", name: "Long", description: "Long instructions.", source: "local", instructionPath }],
  });

  const first = await runTool(ctx, () => undefined, {
    id: "call-long-1",
    name: "read_skill",
    arguments: { skillId: "long" },
  });
  const nextOffset = Number(first.output.match(/Next offset: (\d+)/)?.[1]);
  assert.equal(Number.isFinite(nextOffset), true);
  assert.doesNotMatch(first.output, /Read status: complete/);

  const second = await runTool(ctx, () => undefined, {
    id: "call-long-2",
    name: "read_skill",
    arguments: { skillId: "long", offset: nextOffset },
  });
  assert.match(second.output, /Read status: complete/);
});

test("normalizeModelToolSpec removes schema shapes local model adapters handle poorly", () => {
  const normalized = normalizeModelToolSpec({
    type: "function",
    function: {
      name: "demo",
      description: "demo",
      parameters: {
        properties: {
          path: { type: ["string", "null"] },
          nested: {
            properties: {
              flag: { enum: [true, false] },
            },
            required: "flag",
            additionalProperties: false,
          },
          items: {
            items: { type: ["string", "null"] },
            anyOf: [{ type: "array" }],
          },
        },
        required: ["path", 42],
        additionalProperties: false,
        oneOf: [{ required: ["path"] }],
      },
    },
  });

  const parameters = plain(normalized.function.parameters);
  assert.equal(schemaHasAdapterHostileShapes(parameters), false);
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.required, ["path"]);
  assert.equal(parameters.properties.path.type, "string");
  assert.equal(parameters.properties.nested.type, "object");
  assert.deepEqual(parameters.properties.nested.required, []);
  assert.equal(parameters.properties.nested.additionalProperties, undefined);
  assert.equal(parameters.properties.nested.properties.flag.type, "boolean");
  assert.equal(parameters.properties.items.type, "array");
  assert.equal(parameters.properties.items.anyOf, undefined);
  assert.equal(parameters.properties.items.items.type, "string");
});

test("toolSpecs keep small stable schemas for local model tool calling", () => {
  assert.deepEqual(plain(toolSpecs.map((spec) => spec.function.name)), ["read", "write", "edit", "search", "command"]);
  const readSpec = toolSpecs.find((spec) => spec.function.name === "read");
  const searchSpec = toolSpecs.find((spec) => spec.function.name === "search");
  assert.match(readSpec.function.description, /workspace file/i);
  assert.match(readSpec.function.description, /folder overviews/i);
  assert.match(readSpec.function.description, /completion metadata/i);
  assert.match(readSpec.function.description, /\/workspace/i);
  assert.equal(readSpec.function.parameters.properties.depth.type, "number");
  assert.match(searchSpec.function.description, /file paths and small text-file contents/i);
  assert.match(searchSpec.function.description, /before reading exact files/i);
  assert.match(searchSpec.function.description, /not a complete directory inventory/i);
  const editSpec = toolSpecs.find((spec) => spec.function.name === "edit");
  assert.deepEqual(plain(editSpec.function.parameters.properties.mode.enum), ["replace", "patch"]);
  assert.equal(editSpec.function.parameters.properties.patch.type, "string");
  for (const spec of toolSpecs) {
    const parameters = spec.function.parameters;
    assert.equal(parameters.type, "object", spec.function.name);
    assert.equal(Array.isArray(parameters.required), true, spec.function.name);
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, "oneOf"), false, spec.function.name);
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, "anyOf"), false, spec.function.name);
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, "allOf"), false, spec.function.name);
    for (const property of Object.values(parameters.properties ?? {})) {
      assert.equal(["string", "number", "array"].includes(property.type), true, spec.function.name);
    }
  }
});
