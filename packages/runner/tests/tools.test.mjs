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
      enabledTools: options.enabledTools ?? ["read", "write", "edit", "search", "command"],
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

test("commandTool reports non-zero command exits as structured runtime errors", async () => {
  const root = workspace();
  const allowed = context(root);
  const result = await commandTool(allowed.ctx, { command: "node -e \"process.exit(7)\"" }, "tool-exit");

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
  assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(events[0].summary, "read README.md --limit 1");
  assert.equal(events[1].status, "success");
  assert.equal(events[1].exitCode, 0);
  assert.equal(typeof events[1].durationMs, "number");
  assert.match(events[1].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(events[1].finishedAt, /^\d{4}-\d{2}-\d{2}T/);

  const disabled = context(root, { enabledTools: ["read"] });
  const disabledEvents = [];
  await assert.rejects(
    () => runTool(disabled.ctx, (event) => disabledEvents.push(event), { id: "call-write", name: "write", arguments: { filePath: "x.txt", content: "x" } }),
    /disabled/,
  );
  assert.deepEqual(disabledEvents.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(disabledEvents[1].status, "validation_error");
  assert.equal(disabledEvents[1].errorCode, "tool_disabled");
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
  assert.equal(events[0].summary, "edit patch");
  assert.equal(events[0].commandClass, "edit");
  assert.equal(toolContext.outputs.some((output) => output.toolCallId === "call-patch" && output.text.includes("added notes/run-tool.md")), true);
  assert.equal(fs.readFileSync(path.join(root, "notes", "run-tool.md"), "utf8"), "created through runTool");
});

test("runTool marks malformed model tool arguments as validation errors", async () => {
  const root = workspace();
  const events = [];
  await assert.rejects(
    () => runTool(context(root).ctx, (event) => events.push(event), { id: "bad-args", name: "read", arguments: "{bad json" }),
    /valid JSON/,
  );

  assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.finished"]);
  assert.equal(events[1].status, "validation_error");
  assert.equal(events[1].errorCode, "invalid_arguments");
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
