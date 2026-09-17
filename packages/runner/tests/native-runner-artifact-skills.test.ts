import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, eventCollector, prompt, requestBody, sse, startRunner } from "./native-runner-harness.ts";

test("artifact execution requires real skill reads again on a follow-up", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-skills-"));
  const skill = path.join(cwd, "skill");
  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "Read references/spec.md before creating a document.");
  fs.writeFileSync(path.join(skill, "references/spec.md"), "Use a blocks array of paragraph objects with text.");
  let round = 0;
  let step = 0;
  const provider = http.createServer(async (request, response) => {
    await requestBody(request);
    if (request.url !== "/api/engineering/chat") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const current = step++;
    if (current === 3) {
      response.end(sse({ choices: [{ delta: { content: "Document created." } }] }) + "data: [DONE]\n\n");
      return;
    }
    const calls = current === 1
      ? ["SKILL.md", "references/spec.md"].map((resource, index) => ({
          index, id: `read-${round}-${index}`, type: "function",
          function: { name: "read_skill", arguments: JSON.stringify({ skillId: "umbratic-documents", resource }) },
        }))
      : [{
          index: 0, id: `${current === 0 ? "blocked" : "allowed"}-${round}`, type: "function",
          function: { name: "artifact", arguments: JSON.stringify({
            action: "create", format: "docx", out: `artifacts/docx/round-${round}.docx`,
            spec: { blocks: [{ type: "paragraph", text: "A document." }] },
          }) },
        }];
    response.end(sse({ choices: [{ delta: { tool_calls: calls } }] }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  const run = await startRunner(cwd, `http://127.0.0.1:${address.port}`, path.join(cwd, "runner.jsonl"), {
    permissionMode: "auto_safe", enabledTools: ["artifact"], services: { artifact: true },
    skills: [{ id: "umbratic-documents", name: "Documents", source: "system", instructionPath: path.join(skill, "SKILL.md") }],
  });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    for (round = 1; round <= 2; round++) {
      step = 0;
      const start = events.events.length;
      assert.equal((await prompt(run, session.id, `Create document ${round}.`)).status, 204);
      const blocked = await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === `blocked-${round}`);
      assert.equal(blocked.errorCode, "skill_read_required");
      const job = await events.waitFor((event) => event.type === "artifact.requested" && event.out === `artifacts/docx/round-${round}.docx`);
      for (const id of [`read-${round}-0`, `read-${round}-1`]) {
        const read = events.events.find((event) => event.type === "tool.finished" && event.toolCallId === id);
        assert.equal(read?.status, "success");
        assert.ok(events.events.indexOf(read!) < events.events.indexOf(job));
      }
      const reply = await run.request(`/artifact/${job.artifactId}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, path: job.out, bytes: 100, origin: "umbratic", editSurface: "full", qa: [] }),
      });
      assert.equal(reply.status, 200);
      await events.waitFor((event) => event.type === "run.settled" && events.events.indexOf(event) >= start);
      const observed = events.events.slice(start);
      assert.equal(observed.filter((event) => event.type === "artifact.requested").length, 1);
      for (const id of [`blocked-${round}`, `read-${round}-0`, `read-${round}-1`, `allowed-${round}`]) {
        assert.equal(observed.filter((event) => event.type === "tool.requested" && event.toolCallId === id).length, 1);
        assert.equal(observed.filter((event) => event.type === "tool.finished" && event.toolCallId === id).length, 1);
      }
      assert.equal(observed.find((event) => event.type === "tool.finished" && event.toolCallId === `allowed-${round}`)?.status, "success");
    }
  } finally {
    await events.close();
    await run.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
