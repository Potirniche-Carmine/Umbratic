import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, eventCollector, prompt, requestBody, sse, startRunner } from "./native-runner-harness.ts";
import { startProvider } from "./native-runner-provider.ts";

for (const method of ["stdin", ...(process.platform === "win32" ? [] : ["SIGTERM"])]) {
  test(`${method} shuts down the runner while an event stream is still open`, { timeout: 10_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-stream-shutdown-"));
    const provider = await startProvider();
    const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
    let reader;
    let timer;
    try {
      const response = await run.request("/event");
      assert.equal(response.status, 200);
      reader = response.body!.getReader();
      assert.equal((await reader.read()).done, false, "the event stream is connected");
      const exited = once(run.child, "exit");
      if (method === "stdin") run.child.stdin.end();
      else run.child.kill("SIGTERM");
      const [code, signal] = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("shutdown waited on the open event stream")), 5000); }),
      ]);
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal((await reader.read()).done, true, "the stream closes normally");
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
      await run.close();
      await provider.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("parent disconnect reaps an active tool and its descendant process", { timeout: 15_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-tool-shutdown-"));
  const program = 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]); console.log("shutdown-pids:" + process.pid + "," + child.pid); setInterval(() => {}, 1000);';
  const provider = http.createServer(async (request, response) => {
    await requestBody(request);
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Umbratic-Stream-Version": "2" });
    response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "shutdown-program", function: {
      name: "run_program", arguments: JSON.stringify({ programId: "node", args: ["-e", program] }),
    } }] } }] }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const run = await startRunner(cwd, `http://127.0.0.1:${address.port}`, path.join(cwd, "runner.jsonl"), {
    enabledTools: ["command"], approvedExecutables: [{ id: "node", command: process.execPath }],
  });
  const events = await eventCollector(run);
  const pids: number[] = [];
  let timer;
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "Run the approved shutdown fixture.")).status, 204);
    const permission = await events.waitFor((event) => event.type === "permission.requested");
    const reply = await run.request(`/permission/${permission.permissionId}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }),
    });
    assert.equal(reply.status, 200);
    const output = await events.waitFor((event) => event.type === "tool.output" && String(event.text).includes("shutdown-pids:"));
    const match = /shutdown-pids:(\d+),(\d+)/.exec(String(output.text));
    assert.ok(match);
    pids.push(Number(match[1]), Number(match[2]));
    const exited = once(run.child, "exit");
    run.child.stdin.end();
    const [code, signal] = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("shutdown did not reap the active tool")), 5000); }),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `tool process ${pid} survived shutdown`);
  } finally {
    clearTimeout(timer);
    await events.close();
    await run.close();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
