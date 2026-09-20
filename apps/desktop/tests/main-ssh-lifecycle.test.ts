import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ssh-lifecycle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let spawned = 0;
  let killed = 0;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { killed++; this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); },
  });
  const { runRemoteCommand } = loadTypeScriptModule(new URL("../src/main/sshTransport.ts", import.meta.url), {
    mocks: { "node:child_process": { spawn: () => { spawned++; return child; } } },
  });
  const signal = new AbortController();
  return {
    child, signal, spawned: () => spawned, killed: () => killed,
    run: (options = {}) => runRemoteCommand({ host: "example.invalid", username: "test", port: 22, authMethod: "agent" }, directory, ["true"], { signal: signal.signal, ...options }),
  };
}

test("an already cancelled SSH request never launches a command", async (t) => {
  const f = fixture(t);
  f.signal.abort();
  await assert.rejects(f.run(), /cancelled/);
  assert.equal(f.spawned(), 0);
});

test("SSH cancellation, timeout and stdin failure stop the child and remove abort handlers", async (t) => {
  for (const failure of ["abort", "timeout", "stdin"]) {
    const f = fixture(t);
    const result = f.run({ timeoutMs: failure === "timeout" ? 10 : 1000 });
    if (failure === "abort") f.signal.abort();
    if (failure === "stdin") f.child.stdin.emit("error", new Error("EPIPE"));
    await assert.rejects(result, /cancelled|in time|EPIPE/);
    assert.equal(f.killed(), 1);
    assert.equal(getEventListeners(f.signal.signal, "abort").length, 0);
    assert.equal(f.child.stdout.listenerCount("data"), 0);
    assert.equal(f.child.stderr.listenerCount("data"), 0);
  }
});

test("SSH output preserves split UTF-8 and enforces the cap even for one large chunk", async (t) => {
  const f = fixture(t);
  const result = f.run();
  for (const byte of Buffer.from("雪")) f.child.stdout.write(Buffer.from([byte]));
  f.child.stdout.write(Buffer.alloc(512 * 1024, "a"));
  f.child.stderr.write(Buffer.alloc(512 * 1024, "b"));
  f.child.emit("close", 0);
  const output = await result;
  assert.equal(output.code, 0);
  assert.ok(output.stdout.startsWith("雪"));
  assert.equal(Buffer.byteLength(output.stdout), 256 * 1024);
  assert.equal(Buffer.byteLength(output.stderr), 256 * 1024);
  assert.equal(getEventListeners(f.signal.signal, "abort").length, 0);
});
