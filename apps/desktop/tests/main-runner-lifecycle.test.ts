import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { awaitRunnerListener } = loadTypeScriptModule(new URL("../src/main/runnerLifecycle.ts", import.meta.url));
const expectedUrl = "http://127.0.0.1:12345";

function childProcess() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
}

function assertClean(child) {
  for (const event of ["exit", "error"]) assert.equal(child.listenerCount(event), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
}

test("local and remote readiness require the exact expected loopback listener", async () => {
  const child = childProcess();
  const ready = awaitRunnerListener(child, expectedUrl, { password: "test" }, 1000);
  assert.equal(child.stdin.read().toString(), '{"password":"test"}\n');
  assert.equal(child.stdin.writableEnded, false, "stdin stays open for the session");
  child.stdout.write("banner: umbratic runner listening on http://evil.example\n");
  child.stderr.write("umbratic runner listening on http://127.0.0.1:9999\n");
  let settled = false;
  void ready.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  for (const byte of Buffer.from(`umbratic runner listening on ${expectedUrl}\r\n`)) child.stderr.write(Buffer.from([byte]));
  assert.equal((await ready).ok, true);
  assertClean(child);
});

test("startup timeout, spawn failure, early exit, and broken stdin clean every listener", async () => {
  for (const failure of ["timeout", "error", "exit", "stdin"]) {
    const child = childProcess();
    const ready = awaitRunnerListener(child, expectedUrl, {}, failure === "timeout" ? 10 : 1000);
    if (failure === "error") child.emit("error", new Error("spawn failed"));
    if (failure === "exit") child.emit("exit", 1);
    if (failure === "stdin") child.stdin.emit("error", new Error("EPIPE"));
    assert.equal((await ready).ok, false, failure);
    assertClean(child);
  }
});

test("startup output is bounded, preserves split UTF-8, and identifies port collisions", async () => {
  const child = childProcess();
  const ready = awaitRunnerListener(child, expectedUrl, {}, 1000);
  child.stderr.write("x".repeat(100_000));
  for (const byte of Buffer.from("雪: address already in use\n")) child.stderr.write(Buffer.from([byte]));
  child.emit("exit", 1);
  const result = await ready;
  assert.equal(result.ok, false);
  assert.equal(result.portInUse, true);
  assert.ok(result.output.length <= 16 * 1024);
  assert.ok(result.output.endsWith("雪: address already in use\n"));
  assertClean(child);
});

test("a refused SSH reverse listener is a retryable port collision", async () => {
  const child = childProcess();
  const ready = awaitRunnerListener(child, expectedUrl, {}, 1000);
  child.stderr.write("Error: remote port forwarding failed for listen port 23456\n");
  child.emit("exit", 255);
  assert.equal((await ready).portInUse, true);
  assertClean(child);
});
