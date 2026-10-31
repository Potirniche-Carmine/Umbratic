import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, eventCollector, prompt, requestBody, sse, startRunner } from "./native-runner-harness.ts";

for (const cancel of [false, true]) {
  test(`file preparation is visible before arguments finish (${cancel ? "cancel" : "write"})`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-writing-"));
    let finishArguments: (() => void) | undefined;
    const provider = http.createServer(async (request, response) => {
      const body = await requestBody(request);
      if (request.url !== "/api/engineering/chat") { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (body.messages.some((message) => message.role === "tool")) {
        response.end(sse({ choices: [{ delta: { content: "Saved PRD.md." } }] }) + "data: [DONE]\n\n");
        return;
      }
      response.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "draft-prd", function: { name: "write", arguments: '{"path":"PRD.md","content":"' } }] } }] }));
      finishArguments = () => response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '# Requirements\\nLogin, browse, add and edit data securely.\\n"}' } }] } }] }) + "data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address() as { port: number };
    const run = await startRunner(cwd, `http://127.0.0.1:${address.port}`, path.join(cwd, "runner.jsonl"), { permissionMode: "auto_safe" });
    const events = await eventCollector(run);
    try {
      const session = await createSession(run);
      assert.equal((await prompt(run, session.id, "Write a requirements document to PRD.md.")).status, 204);
      const preparing = await events.waitFor((event) => event.type === "tool.preparing");
      assert.equal(preparing.toolCallId, "draft-prd");
      assert.equal(preparing.toolKind, "write");
      assert.equal(preparing.arguments, undefined);
      assert.equal(fs.existsSync(path.join(cwd, "PRD.md")), false);
      assert.equal(events.events.some((event) => event.type === "tool.requested"), false);
      if (cancel) {
        assert.equal((await run.request(`/session/${session.id}/abort`, { method: "POST" })).status, 204);
      } else finishArguments!();
      await events.waitFor((event) => event.type === "run.settled");
      assert.equal(events.events.filter((event) => event.type === "tool.preparing").length, 1);
      assert.equal(events.events.filter((event) => event.type === "tool.requested").length, cancel ? 0 : 1);
      assert.equal(events.events.filter((event) => event.type === "tool.finished").length, cancel ? 0 : 1);
      if (cancel) assert.equal(fs.existsSync(path.join(cwd, "PRD.md")), false);
      else assert.match(fs.readFileSync(path.join(cwd, "PRD.md"), "utf8"), /Login, browse, add and edit/);
    } finally {
      finishArguments?.();
      await events.close();
      await run.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
