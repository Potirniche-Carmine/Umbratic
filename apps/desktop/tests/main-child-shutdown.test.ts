import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("shutdown escalates a real child that ignores termination and does not mistake killed for exited", { timeout: 10_000 }, async () => {
  const { stopChild, stopRequested } = loadTypeScriptModule(new URL("../src/main/childShutdown.ts", import.meta.url), {
    globals: { setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 10_000, "allow the runner's HTTP, tool, and LSP cleanup grace periods");
      return setTimeout(callback, 50);
    } },
  });
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);']);
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    stopChild(child);
    stopChild(child);
    assert.equal(stopRequested(child), true);
    // Windows uses external taskkill, which does not update this Node flag.
    if (process.platform !== "win32") assert.equal(child.killed, true);
    const [code, signal] = await exited;
    assert.equal(child.exitCode, code);
    assert.equal(child.signalCode, signal);
    if (process.platform === "win32") assert.ok(code !== null || signal !== null);
    else assert.equal(signal, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("a normal exit cancels escalation and a Windows tree terminator failure is handled", () => {
  for (const platform of ["darwin", "win32"]) {
    const signals = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null,
      kill: (signal = "SIGTERM") => { signals.push(signal); return true; },
    });
    const terminator = Object.assign(new EventEmitter(), { unref: () => {} });
    let cleared = false;
    const timer = { unref: () => {} };
    const { stopChild } = loadTypeScriptModule(new URL("../src/main/childShutdown.ts", import.meta.url), {
      globals: {
        process: { platform },
        setTimeout: () => timer,
        clearTimeout: (value) => { assert.equal(value, timer); cleared = true; },
      },
      mocks: { "node:child_process": { spawn: () => terminator } },
    });
    stopChild(child);
    if (platform === "win32") terminator.emit("error", new Error("taskkill unavailable"));
    assert.deepEqual(signals, ["SIGTERM"]);
    child.exitCode = 0;
    child.emit("exit", 0);
    assert.equal(cleared, true);
    stopChild(child);
    assert.deepEqual(signals, ["SIGTERM"]);
  }
});
