import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { verifyLlamaDownloads } from "../scripts/verify-llama-downloads.ts";

const denial = "Remote downloads are disabled in the Umbratic runtime.";
function mockExec(t, callback) {
  t.mock.method(childProcess, "execFile", callback);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("compiled download probes exercise HTTP and HTTPS without offline or GPU initialization", async (t) => {
  const urls = [];
  const directories = [];
  mockExec(t, (_file, args, options, callback) => {
    assert.deepEqual(args.slice(0, 4), ["--device", "none", "--n-gpu-layers", "0"]);
    assert.equal(args.includes("--offline"), false);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.env.GGML_METAL_DEVICES, "0");
    urls.push(new URL(args[args.indexOf("--model-url") + 1]).protocol);
    directories.push(path.dirname(args.at(-1)));
    callback(Object.assign(new Error("nonzero exit"), { code: 1 }), "", denial);
  });
  await verifyLlamaDownloads("llama-server");
  assert.deepEqual(urls, ["http:", "https:"]);
  assert.ok(directories.every((directory) => !fs.existsSync(directory)));
});

test("download probes reject success, missing guards, timeout, crash, and spawn errors with bounded diagnostics", async (t) => {
  let failure = null;
  let output = denial;
  mockExec(t, (_file, _args, _options, callback) => callback(failure, "", output));
  for (const error of [null, { code: 1, killed: true }, { code: 1, signal: "SIGABRT" }, { code: "ENOENT" }, { code: 0 }]) {
    failure = error ? Object.assign(new Error("probe failed"), error) : null;
    await assert.rejects(verifyLlamaDownloads("llama-server"), /did not reject HTTP model downloads/);
  }
  failure = Object.assign(new Error("probe failed"), { code: 1 });
  output = "x".repeat(10_000) + "missing guard tail";
  await assert.rejects(verifyLlamaDownloads("llama-server"), (error) => {
    assert.ok(error.message.length < 3000);
    assert.match(error.message, /missing guard tail/);
    return true;
  });
});

test("a real loopback connection fails even when the child prints the expected denial", async (t) => {
  const sockets = [];
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  mockExec(t, (_file, args, _options, callback) => {
    const url = new URL(args[args.indexOf("--model-url") + 1]);
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    sockets.push(socket);
    socket.once("error", (error) => callback(error, "", ""));
    socket.once("connect", () => {
      socket.end();
      callback(Object.assign(new Error("nonzero exit"), { code: 1 }), "", denial);
    });
  });
  await assert.rejects(verifyLlamaDownloads("llama-server"), /attempted a disabled remote download/);
});
