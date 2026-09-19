import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function runnerFixture(failQueuedCheckpoint = false) {
  const task = { id: "task-turns", prompt: "first", state: "running", events: [], changedFiles: [], reviewFiles: [] };
  const calls = [];
  let event;
  let checkpoint = 0;
  const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
  const run = { child, abortController: new AbortController(), sessionId: undefined };
  const selected = { providerId: "test", modelId: "test", contextLength: 8192 };
  const runtime = {
    activeRunnerProcesses: new Map(), cancelledTaskRuns: new Set(), pendingRunnerPrompts: new Map(),
    pendingTaskSteers: new Map(), pendingTaskCancelWaits: new Map(), pendingPermissions: new Map(),
    pendingTaskFollowUps: new Map([[task.id, [{ actionId: "next", prompt: "second", attachments: [] }]]]),
    getTask: () => task, getPermissionMode: () => "normal", saveTask: () => {}, applyTaskPolicyMetadata: () => {},
    taskStillRunning: () => task.state === "running" && !runtime.cancelledTaskRuns.has(task.id), clearPendingPermissionsForTask: () => {},
    appendUserMessage: (_task, prompt) => calls.push(`message:${prompt}`), emit: () => {}, recordProductTelemetry: () => {},
    failTask: (_task, error) => { task.state = "failed"; calls.push(`failed:${error}`); },
  };
  const mocks = Object.fromEntries([
    "./artifacts/service", "./artifacts/transport", "./chatStore", "./indexerService", "./reviewInsights",
    "./worktreeOps", "./remoteRunner", "./policy", "./companyIdentity", "./processCommands", "./taskReviewPresentation",
  ].map((name) => [name, {}]));
  Object.assign(mocks, {
    "./mainRuntime": runtime,
    "./workspaceActivity": { reserveTaskWorkspace: () => { calls.push("reserved"); return () => calls.push("released"); } },
    "./checkpoints/undo": { captureUndoFiles: () => { task.undoFileHashes = {}; } },
    "./backendSettings": {
      resolveSelectedModel: async () => ({ providers: [], selected }),
      submitSteeredRunnerTurn: async () => { calls.push("submit:second"); queueMicrotask(() => event({ type: "finish" })); },
    },
    "./modelEndpointRuntime": { modelWithFreshContextLength: async () => selected },
    "./endpointConfig": { endpointProvider: () => ({}) },
    "./taskCommands": { prepareTaskTurnCheckpoint: async () => {
      checkpoint++;
      calls.push(`checkpoint:${checkpoint}`);
      if (checkpoint === 2 && failQueuedCheckpoint) throw new Error("snapshot failed");
    } },
    "./taskPromptContext": {
      runnerPromptForTask: async (_task, prompt) => { calls.push(`prompt:${prompt}`); return []; },
      runnerPromptParts: (value) => value,
    },
    "./reviewFiles": { refreshReview: async () => [] },
    "./storage": { readModelEndpointSettings: () => ({ mode: "local" }) },
    "./diagnostics": { recordLocalDiagnostic: () => {} },
    "./runnerEventAdapter": { RunnerEventAdapter: class {
      constructor(options) { this.options = options; }
      handle(value) {
        if (value.type === "finish") this.options.onFinish();
        else if (value.type === "delegated") { this.options.onDelegated(); this.options.onFinish(); }
        else this.options.onQueueUpdated(value);
      }
    } },
    "./runnerAdapter": {
      startUmbraticRunnerServer: async () => run,
      beginRunnerEventStream: (_run, handler) => {
        event = handler;
        return { ready: Promise.resolve(), done: new Promise((resolve) => run.abortController.signal.addEventListener("abort", resolve)) };
      },
      runnerRequest: async (_run, route) => {
        if (route === "/session") return { id: "session" };
        if (route.endsWith("prompt_async")) {
          calls.push("submit:first");
          queueMicrotask(() => { event({ type: "finish" }); event({ disposition: "dequeued", actionId: "next" }); });
        }
      },
      stopRunnerProcess: () => { run.abortController.abort(); calls.push("stopped"); },
    },
  });
  const runner = loadTypeScriptModule(new URL("../src/main/taskRunner.ts", import.meta.url), { mocks });
  return { runner, task, calls, run, runtime, mocks };
}

test("a released follow-up takes its own checkpoint before submitting another model turn", async () => {
  const { runner, task, calls } = runnerFixture();
  await runner.runRunnerTask(task.id);
  assert.deepEqual(calls.filter((call) => /checkpoint|submit|reserved|released|stopped/.test(call)), [
    "reserved", "checkpoint:1", "submit:first", "checkpoint:2", "submit:second", "stopped", "released",
  ]);
  assert.equal(task.state, "completed");
});

test("a failed follow-up checkpoint never submits an unprotected turn and releases the workspace", async () => {
  const { runner, task, calls } = runnerFixture(true);
  await runner.runRunnerTask(task.id);
  assert.equal(task.state, "failed");
  assert.equal(calls.includes("submit:second"), false);
  assert.ok(calls.some((call) => /^failed:.*snapshot failed/.test(call)));
  assert.equal(calls.at(-1), "released");
});

test("cancellation during prompt preparation never starts a runner or submits a turn", async () => {
  const state = runnerFixture();
  state.mocks["./taskPromptContext"].runnerPromptForTask = async () => {
    state.runtime.cancelledTaskRuns.add(state.task.id);
    state.task.state = "completed";
    return [];
  };
  await state.runner.runRunnerTask(state.task.id);
  assert.equal(state.calls.some((call) => call.startsWith("submit:")), false);
  assert.equal(state.calls.includes("stopped"), false);
  assert.equal(state.calls.at(-1), "released");
});

test("workspace stays reserved until runner exit, including shutdown bookkeeping", async () => {
  const state = runnerFixture();
  state.run.child.pid = 42;
  state.run.child.exitCode = null;
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  state.mocks["./runnerAdapter"].stopRunnerProcess = () => {
    state.run.abortController.abort();
    stopped();
  };
  const running = state.runner.runRunnerTask(state.task.id);
  await stopping;
  assert.equal(state.calls.includes("released"), false);
  state.run.child.exitCode = 0;
  state.run.child.emit("exit", 0);
  await running;
  assert.equal(state.calls.at(-1), "released");
});

test("a delayed cancellation cannot overwrite a later restored workspace", async () => {
  const state = runnerFixture();
  let stored = { ...state.task, worktreePath: "/old-workspace" };
  state.runtime.getTask = () => ({ ...stored });
  state.runtime.saveTask = (task) => { stored = { ...task }; };
  state.runtime.runnerGracefulCancelDeadlineMs = 1000;
  state.run.sessionId = "session";
  state.runtime.activeRunnerProcesses.set(state.task.id, state.run);
  let finishRequest;
  state.mocks["./runnerAdapter"].runnerRequest = () => new Promise((resolve) => { finishRequest = resolve; });
  for (const dependency of ["./repositoryOps", "./workspaceSnapshot", "./capabilities", "./remoteHost", "./remoteConnections", "./settingsStorage", "./toolSettings", "./checkpoints/service"]) {
    state.mocks[dependency] = {};
  }
  const actions = loadTypeScriptModule(new URL("../src/main/taskActions.ts", import.meta.url), { mocks: state.mocks });
  const cancelling = actions.cancelTask({ taskId: state.task.id });
  assert.equal(stored.state, "completed");
  stored = { ...stored, worktreePath: "/restored-workspace", turnCheckpointId: undefined };
  state.runtime.pendingTaskCancelWaits.get(state.task.id)();
  finishRequest({ disposition: "applied" });
  await cancelling;
  assert.equal(stored.worktreePath, "/restored-workspace");
});

test("stopping while a worktree is being created cannot resurrect the run", async () => {
  const state = runnerFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-create-stop-"));
  state.task.worktreePath = path.join(root, "editing");
  let finishCreation;
  state.mocks["./processCommands"].execFileOutput = () => new Promise((resolve) => { finishCreation = resolve; });
  try {
    const creating = state.runner.createWorktreeAndRunRunner(state.task);
    assert.equal(state.calls.at(-1), "reserved");
    state.task.state = "completed";
    state.runtime.cancelledTaskRuns.add(state.task.id);
    finishCreation("");
    await creating;
    assert.equal(state.task.state, "completed");
    assert.equal(state.calls.some((call) => call.startsWith("submit:")), false);
    assert.equal(state.calls.at(-1), "released");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("automatic worktree handoff starts only after the first runner releases its workspace", async () => {
  const state = runnerFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-handoff-"));
  state.task.worktreePath = path.join(root, "editing");
  let event;
  let finishCreation;
  state.mocks["./runnerAdapter"].beginRunnerEventStream = (_run, handler) => {
    event = handler;
    return { ready: Promise.resolve(), done: new Promise((resolve) => state.run.abortController.signal.addEventListener("abort", resolve)) };
  };
  state.mocks["./runnerAdapter"].runnerRequest = async (_run, route) => {
    if (route === "/session") return { id: "session" };
    if (route.endsWith("prompt_async")) queueMicrotask(() => event({ type: "delegated" }));
  };
  state.mocks["./processCommands"].execFileOutput = () => {
    state.calls.push("create-worktree");
    return new Promise((resolve) => { finishCreation = resolve; });
  };
  try {
    await state.runner.runRunnerTask(state.task.id);
    assert.deepEqual(state.calls.filter((call) => /reserved|released|stopped|create-worktree/.test(call)), [
      "reserved", "stopped", "released", "reserved", "create-worktree",
    ]);
    state.task.state = "completed";
    state.runtime.cancelledTaskRuns.add(state.task.id);
    finishCreation("");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.calls.at(-1), "released");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
