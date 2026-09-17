import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const request = { action: "create", format: "docx", workspaceRoot: "/workspace", out: "PRD.docx" };
const response = { ok: true, path: "PRD.docx", bytes: 123 };

function workerHarness() {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(value: unknown): void;
    kill(): void;
  };
  const sent: unknown[] = [];
  let killed = 0;
  child.postMessage = (value) => sent.push(value);
  child.kill = () => { killed += 1; };
  const { runInWorker } = loadTypeScriptModule(new URL("../src/main/artifacts/service.ts", import.meta.url), {
    mocks: { electron: { utilityProcess: { fork: () => child } }, "node:fs": { existsSync: () => true } },
  });
  return { child, sent, runInWorker, killed: () => killed };
}

test("artifact jobs wait for spawn, then settle once and clean up the worker", async () => {
  const h = workerHarness();
  const pending = h.runInWorker(request, 1000);
  assert.equal(h.sent.length, 0, "Electron discards pre-spawn messages");
  h.child.emit("spawn");
  assert.deepEqual(h.sent, [request]);
  h.child.emit("message", response);
  assert.deepEqual(await pending, response);
  h.child.emit("exit", 0);
  assert.equal(h.killed(), 1);
  assert.equal(h.child.listenerCount("spawn"), 0);
});

for (const failure of ["exit", "error", "malformed", "timeout", "send"] as const) {
  test(`artifact worker ${failure} produces a failure and cleans up`, async () => {
    const h = workerHarness();
    const pending = h.runInWorker(request, failure === "timeout" ? 10 : 1000);
    if (failure === "send") {
      h.child.postMessage = () => { throw new Error("closed"); };
      h.child.emit("spawn");
    } else if (failure === "malformed") h.child.emit("message", { unexpected: true });
    else if (failure === "error") h.child.emit("error", new Error("startup failed"));
    else if (failure === "exit") h.child.emit("exit", 1);
    assert.equal((await pending).ok, false);
    assert.equal(h.killed(), 1);
    h.child.emit("spawn");
    assert.equal(h.sent.length, 0, "a timed-out job must not be sent by a late spawn");
  });
}

test("artifact utility entry point unwraps Electron message data and handles one job", async () => {
  const port = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  const received: unknown[] = [];
  const replied = new Promise<unknown>((resolve) => { port.postMessage = resolve; });
  loadTypeScriptModule(new URL("../src/main/artifacts/worker/index.ts", import.meta.url), {
    globals: { process: { parentPort: port } },
    mocks: { "./engine.js": { runArtifactJob: async (value: unknown) => { received.push(value); return response; } } },
  });
  port.emit("message", { data: request, ports: [] });
  assert.deepEqual(await replied, response);
  port.emit("message", { data: request, ports: [] });
  assert.deepEqual(received, [request]);
});
