import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, eventCollector, prompt, requestBody, sse, startRunner } from "./native-runner-harness.ts";

test("every request carries the complete catalog and arbitrary skills load on demand or explicit selection", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skills-"));
  const skill = path.join(cwd, "skill");
  const body = "Custom release instructions: read references/checklist.md before preparing a handoff.";
  const reference = "Include an owner and rollback procedure in the handoff.";
  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), body);
  fs.writeFileSync(path.join(skill, "references/checklist.md"), reference);
  fs.writeFileSync(path.join(cwd, "documents.md"), "Bundled document instructions.");
  const skills = [
    { id: "custom-release-handoff", name: "Release Handoff", description: "Use for release handoffs.", source: "local", instructionPath: path.join(skill, "SKILL.md") },
    { id: "umbratic-documents", name: "Documents", description: "Use for Word documents.", source: "system", instructionPath: path.join(cwd, "documents.md") },
  ];
  const requests: Array<Record<string, unknown>> = [];
  let round = 0;
  let step = 0;
  const provider = http.createServer(async (request, response) => {
    const incoming = await requestBody(request);
    if (request.url !== "/api/engineering/chat") { response.writeHead(404); response.end(); return; }
    requests.push(incoming);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const current = step++;
    const createStep = round === 1 ? 2 : 0;
    if (current > createStep) {
      response.end(sse({ choices: [{ delta: { content: "Handoff created." } }] }) + "data: [DONE]\n\n");
      return;
    }
    const reading = current < createStep;
    const call = {
      index: 0, id: `${reading ? `read-${current}` : "create"}-${round}`, type: "function",
      function: {
        name: reading ? "read_skill" : "artifact",
        arguments: JSON.stringify(reading ? {
          skillId: skills[0].id, resource: current === 0 ? "SKILL.md" : "references/checklist.md",
        } : {
          action: "create", format: "docx", out: `artifacts/docx/round-${round}.docx`,
          spec: { blocks: [{ type: "paragraph", text: "Owner: Alex. Rollback: restore previous release." }] },
        }),
      },
    };
    response.end(sse({ choices: [{ delta: { tool_calls: [call] } }] }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  const run = await startRunner(cwd, `http://127.0.0.1:${address.port}`, path.join(cwd, "runner.jsonl"), {
    permissionMode: "auto_safe", enabledTools: ["artifact"], services: { artifact: true }, skills,
  });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    for (round = 1; round <= 2; round++) {
      step = 0;
      const start = events.events.length;
      const requestStart = requests.length;
      const input = round === 1 ? "Prepare a release handoff document." : "Use $custom-release-handoff to prepare another handoff.";
      assert.equal((await prompt(run, session.id, input)).status, 204);
      const job = await events.waitFor((event) => event.type === "artifact.requested" && event.out === `artifacts/docx/round-${round}.docx`);
      const reply = await run.request(`/artifact/${job.artifactId}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, path: job.out, bytes: 100, origin: "umbratic", editSurface: "full", qa: [] }),
      });
      assert.equal(reply.status, 200);
      await events.waitFor((event) => event.type === "run.settled" && events.events.indexOf(event) >= start);
      const observed = events.events.slice(start);
      const turnRequests = requests.slice(requestStart);
      assert.equal(turnRequests.length, round === 1 ? 4 : 2);
      for (const request of turnRequests) {
        assert.deepEqual(request.skills, skills.map(({ instructionPath: _, ...metadata }) => ({ ...metadata, paths: [] })));
        assert.ok(!JSON.stringify(request.skills).includes("instructionPath"));
      }
      const initial = JSON.stringify(turnRequests[0].messages);
      if (round === 1) {
        assert.ok(!initial.includes(body));
        assert.ok(!initial.includes(reference));
        assert.ok(JSON.stringify(turnRequests[1].messages).includes(body));
        assert.ok(JSON.stringify(turnRequests[2].messages).includes(reference));
        for (const id of ["read-0-1", "read-1-1"]) {
          const read = observed.find((event) => event.type === "tool.finished" && event.toolCallId === id);
          assert.equal(read?.status, "success");
          assert.ok(observed.indexOf(read!) < observed.indexOf(job));
          assert.equal(observed.filter((event) => event.type === "tool.requested" && event.toolCallId === id).length, 1);
          assert.equal(observed.filter((event) => event.type === "tool.finished" && event.toolCallId === id).length, 1);
        }
      } else {
        assert.ok(initial.includes(body));
        assert.ok(initial.includes(reference));
        assert.equal(observed.find((event) => event.type === "skill.loaded")?.skillId, skills[0].id);
        assert.ok(observed.findIndex((event) => event.type === "skill.loaded") < observed.indexOf(job));
      }
      // Execution is generic: no special prerequisite for a hardcoded bundled
      // format id; explicit preflight supplies the skill on the follow-up.
      assert.ok(!initial.includes("Bundled document instructions."));
      assert.equal(observed.filter((event) => event.type === "artifact.requested").length, 1);
      assert.equal(observed.filter((event) => event.type === "tool.requested" && event.toolCallId === `create-${round}`).length, 1);
      const finished = observed.filter((event) => event.type === "tool.finished" && event.toolCallId === `create-${round}`);
      assert.equal(finished.length, 1);
      assert.equal(finished[0].status, "success");
    }
  } finally {
    await events.close();
    await run.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
