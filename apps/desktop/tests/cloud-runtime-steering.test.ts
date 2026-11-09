import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { defaultCloudSettings } = loadTypeScriptModule(new URL("../src/shared/cloud.ts", import.meta.url), { realm: "host" });
const tick = () => new Promise(resolve => setImmediate(resolve));
const policy = { cloudEnvironment: () => ({}), cloudWorkflowInstructions: () => "", cloudWorkspaceInstructions: () => "", enabledCloudRoles: () => [], validateCloudConnection() {} };
const workspace = { key: "chat", provider: "codex", path: process.cwd(), entries: [], state: "running", approvals: [], compactions: 0 };
const sink = () => ({ session() {}, text() {}, thinking() {}, activity() {}, compact() {}, usage() {}, limits() {}, complete() {}, approval: async () => ({ allow: false }) });

test("Codex steering waits for the active turn id and sends input without changing its settings", async () => {
  const requests = []; let rpc; let start;
  const settings = defaultCloudSettings(); settings.providers.codex.executable = process.execPath;
  class FakeRpc {
    onMessage = () => {}; onClose = () => {};
    constructor() { rpc = this; }
    send() {} close() {}
    async request(method, params) {
      requests.push({ method, params });
      if (method === "account/read") return { account: { type: "chatgpt", email: "test", planType: "pro" } };
      if (method === "model/list") return { data: [] };
      if (method === "thread/start") return { thread: { id: "native-thread" } };
      if (method === "turn/start") return new Promise(resolve => { start = resolve; });
      return {};
    }
  }
  const { codexCloudRuntime } = loadTypeScriptModule(new URL("../src/main/cloudCodex.ts", import.meta.url), {
    realm: "host", mocks: { "./cloudTransport": { CloudRpc: FakeRpc }, "./cloudPolicy": policy },
  });
  const run = codexCloudRuntime.run(settings, workspace, "Initial", sink());
  const steering = run.steer("Focus on failures", [{ path: "/shot.png", mimeType: "image/png" }, { path: "/notes.txt", mimeType: "text/plain" }]);
  await tick(); assert.equal(requests.some(request => request.method === "turn/steer"), false);
  start({ turn: { id: "active-turn" } }); await steering;
  const params = requests.find(request => request.method === "turn/steer").params;
  assert.equal(params.threadId, "native-thread"); assert.equal(params.expectedTurnId, "active-turn");
  assert.equal(params.input[0].text, "Focus on failures");
  assert.deepEqual(params.input[1], { type: "localImage", path: "/shot.png" });
  assert.match(params.input[2].text, /Attached file: \/notes.txt/);
  assert.equal("model" in params, false); assert.equal("effort" in params, false);
  rpc.onMessage({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "active-turn", status: "completed" } } });
  await run.done;
  await assert.rejects(run.steer("Too late"), /finished/);
});

test("the Claude input stream stays open for steering, preserves images, and closes on cancellation", async () => {
  const { PromptGate, claudePromptContent } = loadTypeScriptModule(new URL("../src/main/cloudClaudeInput.ts", import.meta.url), {
    realm: "host", mocks: { "node:fs": { readFileSync: () => Buffer.from("image") } },
  });
  const gate = new PromptGate(); const stream = gate.messages();
  gate.send("Initial"); assert.equal((await stream.next()).value.message.content, "Initial");
  const next = stream.next();
  gate.send(claudePromptContent("Steering", [{ path: "/shot.png", mimeType: "image/png" }]), "now");
  const message = (await next).value;
  assert.equal(message.priority, "now"); assert.equal(message.message.content[0].text, "Steering");
  assert.equal(message.message.content[1].source.data, Buffer.from("image").toString("base64"));
  const waiting = stream.next(); gate.close(); assert.equal((await waiting).done, true);
  assert.throws(() => gate.send("Late"), /finished/);
});

test("Claude keeps consuming after an older result until its steering message is answered", async () => {
  const sent = []; const output = []; let wake; let closed = false; let inputFinished;
  const inputDone = new Promise(resolve => { inputFinished = resolve; });
  const query = {
    initializationResult: async () => ({ claude_code_version: "test" }),
    accountInfo: async () => ({ subscriptionType: "team" }), supportedModels: async () => [],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
    getContextUsage: async () => ({}), interrupt: async () => {},
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (output.length) yield output.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
  const sdk = { query({ prompt }) {
    void (async () => { for await (const message of prompt) sent.push(message); inputFinished(); })();
    return query;
  } };
  const { claudeCloudRuntime } = loadTypeScriptModule(new URL("../src/main/cloudClaude.ts", import.meta.url), {
    realm: "host", mocks: {
      "@anthropic-ai/claude-agent-sdk": sdk, "./cloudPolicy": policy,
      "./cloudUsage": { optionalRuntimeRead: async value => value, claudeUsage: () => ({ limits: [{ id: "weekly", usedPercent: 0 }] }), planLabel: value => value, claudeModelLabel: id => id },
      "node:child_process": { execFile(_file, _args, _options, callback) { callback(null, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); } },
    },
  });
  const settings = defaultCloudSettings(); settings.providers.claude.executable = process.execPath;
  const run = claudeCloudRuntime.run(settings, { ...workspace, provider: "claude" }, "Initial", sink());
  let finished = false; void run.done.then(() => { finished = true; });
  await run.steer("New direction"); await tick();
  assert.equal(sent.length, 2); assert.equal(sent[1].priority, "now");
  output.push({ type: "result", is_error: false, user_message_uuid: sent[0].uuid, queued_turn_count: 1 }); wake();
  await tick(); assert.equal(closed, false); assert.equal(finished, false);
  output.push({ type: "result", is_error: false, user_message_uuids: sent.map(message => message.uuid), queued_turn_count: 0 }); wake();
  await run.done; await inputDone;
  assert.equal(closed, true); assert.equal(finished, true);
  await assert.rejects(run.steer("Late direction"), /finished/);
});
