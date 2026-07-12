import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const cache = new Map();
const { ToolRegistry } = loadTypeScriptModule(new URL("../src/tools/registry.ts", import.meta.url).pathname, { cache });
const { ToolScheduler } = loadTypeScriptModule(new URL("../src/tools/scheduler.ts", import.meta.url).pathname, { cache });
const { buildToolPlan } = loadTypeScriptModule(new URL("../src/tools/planner.ts", import.meta.url).pathname, { cache });

function definition(name, mode, execute) {
  return {
    name: { name }, label: name, description: name, parameters: { type: "object", properties: {}, required: [] },
    exposure: "direct", executionMode: mode, risk: "read",
    validateArguments: (raw) => raw,
    createIntent: () => ({ risk: "read", summary: name }),
    execute,
  };
}

function context() {
  return {
    taskId: "task-runtime", cwd: process.cwd(), permissionMode: "bypass", enabledTools: [],
    signal: new AbortController().signal,
    askPermission: async () => "allow",
    emitToolOutput() {},
  };
}

function call(name, index) {
  return { id: `call-${index}`, name: { name }, payload: { kind: "function", arguments: {} }, index };
}

test("registry rejects duplicate canonical names", () => {
  const first = definition("same", "parallel", async () => ({ title: "same", status: "success", content: [] }));
  assert.throws(() => new ToolRegistry([first, { ...first }]), /Duplicate tool definition/);
});

test("turn plans keep advertised and executable tools in one immutable snapshot", async () => {
  const enabled = ["read"];
  const plan = buildToolPlan({ enabledTools: enabled });
  enabled.push("write");
  assert.equal(plan.modelSpecs.map((spec) => spec.function.name).join(","), "read");
  const events = [];
  const writeCall = { ...call("write", 0), payload: { kind: "function", arguments: { filePath: "snapshot.txt", content: "x" } } };
  const result = await plan.registry.dispatch(context(), (event) => events.push(event), writeCall);
  assert.equal(result.error.code, "tool_disabled");
  assert.equal(events.filter((event) => event.type === "tool.finished").length, 1);
});

test("scheduler overlaps parallel calls, gates exclusive calls, and returns model order", async () => {
  let active = 0;
  let parallelPeak = 0;
  const starts = [];
  const finish = async (name, delay) => {
    starts.push(name);
    active += 1;
    parallelPeak = Math.max(parallelPeak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return { title: name, status: "success", content: [{ type: "text", text: name }] };
  };
  const defs = [
    definition("slow", "parallel", () => finish("slow", 35)),
    definition("fast", "parallel", () => finish("fast", 5)),
    definition("write", "exclusive", () => finish("write", 1)),
  ];
  const registry = new ToolRegistry(defs);
  const plan = { registry, modelSpecs: [], parallelToolCalls: true, fingerprint: "test-plan" };
  const results = await new ToolScheduler().execute(plan, context(), () => undefined, [call("slow", 0), call("fast", 1), call("write", 2)]);
  assert.equal(parallelPeak, 2);
  assert.equal(starts.join(","), "slow,fast,write");
  assert.equal(results.map((result) => result.title).join(","), "slow,fast,write");
});

test("registry emits one terminal event when validation fails", async () => {
  const invalid = definition("invalid", "parallel", async () => { throw new Error("must not execute"); });
  invalid.validateArguments = () => { throw new Error("bad input"); };
  const events = [];
  const result = await new ToolRegistry([invalid]).dispatch(context(), (event) => events.push(event), call("invalid", 0));
  assert.equal(result.status, "runtime_error");
  assert.equal(events.filter((event) => event.type === "tool.started").length, 1);
  assert.equal(events.filter((event) => event.type === "tool.finished").length, 1);
});

test("aborted calls have one explicit terminal outcome", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = { ...context(), signal: controller.signal };
  const events = [];
  const read = definition("read-test", "parallel", async () => ({ title: "read-test", status: "success", content: [] }));
  const result = await new ToolRegistry([read]).dispatch(ctx, (event) => events.push(event), call("read-test", 0));
  assert.equal(result.status, "aborted");
  assert.equal(events.filter((event) => event.type === "tool.finished").length, 1);
});
