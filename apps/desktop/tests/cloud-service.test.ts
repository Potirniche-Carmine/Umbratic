import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-cloud-service-"));
  const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, payload TEXT)");
  const secondRoot = path.join(directory, "second"); fs.mkdirSync(secondRoot);
  const calls = []; const events = []; const loginStops = [];
  const runtime = {
    connection: undefined,
    async inspect() { return runtime.connection; },
    async signOut() {},
    run(settings, workspace, prompt, sink) {
      let resolve; let reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      const call = { settings, workspace, prompt, sink, resolve, reject };
      calls.push(call);
      return { done, stop: async () => reject(new Error("Interrupted")) };
    },
  };
  const service = loadTypeScriptModule(new URL("../src/main/cloudService.ts", import.meta.url), {
    realm: "host", mocks: {
      electron: { app: { getPath: () => directory } },
      "./storageDatabase": { withAppDatabase: fn => fn(db) },
      "./storage": { readProjects: () => [{ id: "project", rootPath: directory }, { id: "second", rootPath: secondRoot }] },
      "./mainRuntime": { getMainWindow: () => ({ webContents: { send: (_, snapshot) => events.push(structuredClone(snapshot)) } }) },
      "./cloudCodex": { codexCloudRuntime: runtime, stopCodexLogin: () => loginStops.push("codex") },
      "./cloudClaude": { claudeCloudRuntime: runtime, stopClaudeLogin: () => loginStops.push("claude") },
    },
  });
  return { service, calls, events, db, loginStops, runtime, close: () => { service.stopCloudService(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("cached quotas survive an empty fetch but do not cross provider or account boundaries", async () => {
  const f = fixture();
  try {
    const usage = { fetchedAt: new Date().toISOString(), limits: [{ id: "weekly", label: "Weekly", usedPercent: 31 }] };
    f.runtime.connection = { provider: "claude", state: "ready", models: [], account: "first", usage };
    assert.equal((await f.service.inspectCloudProvider({ provider: "claude" })).usage.limits[0].usedPercent, 31);
    f.runtime.connection = { ...f.runtime.connection, usage: { ...usage, limits: [] } };
    assert.equal((await f.service.inspectCloudProvider({ provider: "claude" })).usage.limits[0].usedPercent, 31);
    f.runtime.connection = { ...f.runtime.connection, account: "second", usage: undefined };
    assert.equal((await f.service.inspectCloudProvider({ provider: "claude" })).usage, undefined);
    f.runtime.connection = { ...f.runtime.connection, provider: "codex", account: "first" };
    assert.equal((await f.service.inspectCloudProvider({ provider: "codex" })).usage, undefined);
  } finally { f.close(); }
});

test("file previews only read bounded text inside the selected roots, including symlink resolution", () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-outside-"));
  try {
    const workspace = f.service.getCloudWorkspace({ provider: "codex", repositoryId: "project" });
    fs.writeFileSync(path.join(workspace.path, "hello.ts"), "export const greeting = 'Hello';");
    assert.match(f.service.readCloudFile({ key: workspace.key, path: "hello.ts" }).text, /Hello/);
    fs.writeFileSync(path.join(outside, "private.txt"), "outside");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(workspace.path, "escape.txt"));
    assert.throws(() => f.service.readCloudFile({ key: workspace.key, path: "escape.txt" }), /outside/);
    assert.throws(() => f.service.readCloudFile({ key: workspace.key, path: path.join(outside, "private.txt") }), /outside/);
    fs.writeFileSync(path.join(workspace.path, "large.txt"), "x".repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(workspace.path, "binary.bin"), Buffer.from([0, 1, 2]));
    assert.throws(() => f.service.readCloudFile({ key: workspace.key, path: "large.txt" }), /256 KB/);
    assert.throws(() => f.service.readCloudFile({ key: workspace.key, path: "binary.bin" }), /text/);
    assert.throws(() => f.service.readCloudFile({ key: "other", path: "hello.ts" }), /again/);
  } finally { f.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("provider and chat boundaries preserve native sessions without replaying other conversations", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex", repositoryId: "project" };
    const first = f.service.startCloudTurn({ ...input, prompt: "First instruction" });
    assert.throws(() => f.service.resetCloudContext({ key: first.key }), /Stop/);
    f.calls[0].sink.session("native-1", "account"); f.calls[0].sink.text("answer", "A completed result", false);
    f.calls[0].resolve(); await tick();
    const other = f.service.getCloudWorkspace({ provider: "claude", repositoryId: "project" });
    assert.notEqual(other.key, first.key); assert.deepEqual(other.entries, []);
    f.service.startCloudTurn({ provider: "claude", repositoryId: "project", prompt: "Claude work" });
    assert.equal(f.calls[1].prompt, "Claude work"); assert.equal(f.calls[1].workspace.sessionId, undefined);
    assert.equal(f.service.getCloudWorkspace(input).sessionId, "native-1");
    f.calls[1].sink.session("claude-native", "claude-account"); f.calls[1].resolve(); await tick();
    f.service.startCloudTurn({ ...input, prompt: "Back to ChatGPT" });
    assert.equal(f.calls[2].workspace.sessionId, "native-1"); assert.equal(f.calls[2].prompt, "Back to ChatGPT");
    f.calls[2].resolve(); await tick();
    const newChat = f.service.createCloudChat(input);
    assert.notEqual(newChat.key, first.key); assert.deepEqual(newChat.entries, []);
    f.service.startCloudTurn({ provider: "codex", key: newChat.key, prompt: "Separate task" });
    assert.equal(f.calls[3].workspace.sessionId, undefined); assert.equal(f.calls[3].prompt, "Separate task");
    assert.throws(() => f.service.deleteCloudChat({ key: newChat.key, provider: "codex" }), /Stop/);
    f.calls[3].resolve(); await tick();
    assert.equal(f.service.listCloudChats({ provider: "codex" }).length, 2);
    assert.equal(f.service.listCloudChats({ provider: "claude" }).length, 1);
    assert.throws(() => f.service.getCloudWorkspace({ provider: "claude", key: first.key }), /different provider/);
    assert.throws(() => f.service.deleteCloudChat({ provider: "claude", key: first.key }), /no longer available/);
    f.service.resetCloudContext({ key: first.key });
    assert.deepEqual(f.service.getCloudWorkspace(input).entries, []);
    assert.equal(f.service.getCloudWorkspace({ provider: "claude", key: other.key }).sessionId, "claude-native");
    assert.equal(f.service.getCloudWorkspace({ provider: "codex", key: newChat.key }).entries[0].text, "Separate task");
    f.service.deleteCloudChat({ provider: "codex", key: newChat.key });
    assert.throws(() => f.service.getCloudWorkspace({ provider: "codex", key: newChat.key }), /no longer available/);
    assert.throws(() => f.service.getCloudWorkspace({ ...input, chatId: "../invalid" }), /Invalid chat/);
  } finally { f.close(); }
});

test("approval replies are bound to the workspace, one-use, and denied on cancellation", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex" };
    const workspace = f.service.startCloudTurn({ ...input, prompt: "Inspect" });
    const reply = f.calls[0].sink.approval({ title: "Command", detail: "read file" });
    const pending = f.service.getCloudWorkspace(input).approvals[0];
    assert.throws(() => f.service.respondCloudApproval({ key: "wrong", id: pending.id, allow: true }), /no longer pending/);
    f.service.respondCloudApproval({ key: workspace.key, id: pending.id, allow: false });
    assert.equal((await reply).allow, false);
    assert.throws(() => f.service.respondCloudApproval({ key: workspace.key, id: pending.id, allow: true }), /no longer pending/);
    const waiting = f.calls[0].sink.approval({ title: "Another command", detail: "write file" });
    await f.service.stopCloudTurn({ key: workspace.key }); await tick();
    assert.equal((await waiting).allow, false);
    const stopped = f.service.getCloudWorkspace(input);
    assert.equal(stopped.state, "idle"); assert.equal(stopped.approvals.length, 0);
    assert.equal(stopped.entries.some(entry => entry.kind === "error"), false);
  } finally { f.close(); }
});

test("streamed answers replace by native message id and startup errors release the workspace", async () => {
  const f = fixture();
  try {
    const input = { provider: "claude" };
    f.service.startCloudTurn({ ...input, prompt: "Hello" });
    f.calls[0].sink.session("native", "account");
    f.calls[0].sink.text("message", "Hel", true); f.calls[0].sink.text("message", "lo", true);
    f.calls[0].sink.text("message", "Hello", false);
    f.calls[0].reject(new Error("Subscription not active")); await tick();
    const result = f.service.getCloudWorkspace(input);
    assert.equal(result.state, "idle"); assert.equal(result.entries.filter(entry => entry.kind === "answer").length, 1);
    assert.equal(result.entries.find(entry => entry.kind === "answer").text, "Hello");
    assert.equal(result.entries.at(-1).text, "Subscription not active");
    const saved = f.service.getCloudSettings(); saved.mode = "cloud";
    assert.equal(f.service.saveCloudSettings(saved).mode, "cloud");
  } finally { f.close(); }
});


test("inactivity persists across app restarts and resets before the next instruction", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex", repositoryId: "project" };
    const fresh = f.service.getCloudWorkspace(input);
    // An uncached provider/workspace loads its last completed turn from SQLite.
    const otherInput = { provider: "claude", repositoryId: "second" };
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(`claude\0${path.join(fresh.path, "second")}`).digest("hex");
    f.db.prepare("INSERT INTO settings (key,payload) VALUES (?,?)").run(`cloud:workspace:${key}`, JSON.stringify({
      ...fresh, key, path: path.join(fresh.path, "second"), entries: [{ id: "previous", kind: "instruction", text: "Earlier work", at: "2020-01-01T00:00:00Z" }], provider: "claude", sessionId: "previous-session", lastActiveAt: "2020-01-01T00:00:00Z",
    }));
    f.service.startCloudTurn({ ...otherInput, prompt: "New work" });
    assert.equal(f.calls[0].workspace.sessionId, undefined);
    assert.ok(f.calls[0].workspace.entries.some(entry => /3 hours away/.test(entry.text)));
    f.calls[0].resolve(); await tick();
    assert.ok(Date.now() - Date.parse(f.service.getCloudWorkspace(otherInput).lastActiveAt) < 2000);
  } finally { f.close(); }
});


test("cancelling sign-in stops only the chosen provider and does not block settings", () => {
  const f = fixture();
  try {
    f.service.cancelCloudSignIn({ provider: "claude" });
    assert.deepEqual(f.loginStops, ["claude"]);
    f.service.cancelCloudSignIn({ provider: "codex" });
    assert.deepEqual(f.loginStops, ["claude", "codex"]);
    assert.throws(() => f.service.cancelCloudSignIn({ provider: "other" }));
    const settings = f.service.getCloudSettings(); settings.provider = "codex";
    assert.equal(f.service.saveCloudSettings(settings).provider, "codex");
  } finally { f.close(); }
});

test("multi-folder identity is independent of selection order and rejects unregistered roots", () => {
  const f = fixture();
  try {
    const first = f.service.getCloudWorkspace({ provider: "codex", repositoryIds: ["project", "second"] });
    const reordered = f.service.getCloudWorkspace({ provider: "codex", repositoryIds: ["second", "project", "second"] });
    assert.equal(first.key, reordered.key); assert.equal(first.paths.length, 2);
    assert.notEqual(first.key, f.service.getCloudWorkspace({ provider: "codex", repositoryId: "project" }).key);
    assert.throws(() => f.service.getCloudWorkspace({ provider: "codex", repositoryIds: ["project", "/private"] }), /Open the workspace/);
  } finally { f.close(); }
});

test("tool completion updates one row and keeps its original description", async () => {
  const f = fixture();
  try {
    const input = { provider: "claude" };
    f.service.startCloudTurn({ ...input, prompt: "Check" });
    f.calls[0].sink.session("session", "account");
    f.calls[0].sink.activity("Read", { id: "tool-1", label: "Read file", detail: "README.md", status: "running" });
    f.calls[0].sink.activity("Tool finished", { id: "tool-1", label: "Tool finished", status: "completed" });
    f.calls[0].resolve(); await tick();
    const activities = f.service.getCloudWorkspace(input).entries.filter(entry => entry.kind === "activity");
    assert.equal(activities.length, 1); assert.equal(activities[0].tool.label, "Read file");
    assert.equal(activities[0].tool.status, "completed"); assert.equal(activities[0].tool.detail, "README.md");
  } finally { f.close(); }
});

test("reset deletes only its own history and unreferenced attachments", () => {
  const f = fixture();
  try {
    const first = f.service.getCloudWorkspace({ provider: "codex", repositoryId: "project" });
    const second = f.service.getCloudWorkspace({ provider: "claude", repositoryId: "project" });
    const imageRoot = path.join(first.path, "cloud", "images"); fs.mkdirSync(imageRoot, { recursive: true });
    const unique = randomUUID(); const shared = randomUUID(); const draft = randomUUID();
    for (const id of [unique, shared, draft]) {
      fs.writeFileSync(path.join(imageRoot, `${id}.txt`), "Attachment contents");
      fs.writeFileSync(path.join(imageRoot, `${id}.json`), JSON.stringify({ id, extension: ".txt" }));
    }
    const entry = (id, images) => ({ id, kind: "instruction", text: "Saved conversation", at: "2026-11-03T00:00:00Z", images: images.map(id => ({ id })) });
    const insert = f.db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)");
    insert.run(`cloud:workspace:${first.key}`, JSON.stringify({ ...first, entries: [entry("old", [unique, shared])] }));
    insert.run(`cloud:workspace:${second.key}`, JSON.stringify({ ...second, entries: [entry("other", [shared])] }));
    assert.deepEqual(f.service.resetCloudContext({ key: first.key }).entries, []);
    assert.equal(fs.existsSync(path.join(imageRoot, `${unique}.txt`)), false);
    assert.equal(fs.existsSync(path.join(imageRoot, `${unique}.json`)), false);
    assert.equal(fs.existsSync(path.join(imageRoot, `${shared}.txt`)), true);
    assert.equal(fs.existsSync(path.join(imageRoot, `${draft}.txt`)), true);
    assert.match(f.db.prepare("SELECT payload FROM settings WHERE key = ?").get(`cloud:workspace:${second.key}`).payload, /Saved conversation/);
    f.service.resetCloudContext({ key: second.key });
    assert.equal(fs.existsSync(path.join(imageRoot, `${shared}.txt`)), false);
  } finally { f.close(); }
});

test("shared history migrates once to its last provider and retains that native session", () => {
  const f = fixture();
  try {
    const root = f.service.getCloudWorkspace({ provider: "codex", repositoryId: "project" }).path;
    const path2 = path.join(root, "second");
    const key = createHash("sha256").update(`shared\0${path2}`).digest("hex");
    const old = { key, path: path2, provider: "claude", state: "idle", compactions: 0, sessionId: "old-native", lastActiveAt: new Date().toISOString(), entries: [
      { id: "old", kind: "instruction", text: "Saved history", at: new Date().toISOString() },
    ], sessions: { codex: { sessionId: "other-native", compactions: 0 }, claude: { sessionId: "old-native", compactions: 0 } } };
    f.db.prepare("INSERT INTO settings (key, payload) VALUES (?, ?)").run(`cloud:workspace:${key}`, JSON.stringify(old));
    assert.deepEqual(f.service.listCloudChats({ provider: "codex" }), []);
    const chats = f.service.listCloudChats({ provider: "claude" });
    assert.equal(chats.length, 1); assert.equal(chats[0].title, "Saved history");
    const restored = f.service.getCloudWorkspace({ provider: "claude", key: chats[0].key });
    assert.equal(restored.sessionId, "old-native"); assert.equal(restored.sessions.codex, undefined);
    assert.equal(f.db.prepare("SELECT key FROM settings WHERE key = ?").get(`cloud:workspace:${key}`), undefined);
    assert.equal(f.service.listCloudChats({ provider: "claude" }).length, 1);
    f.service.deleteCloudChat({ provider: "claude", key: restored.key });
    assert.deepEqual(f.service.listCloudChats({ provider: "claude" }), []);
  } finally { f.close(); }
});

test("completion publishes the final answer before quota refresh and does not inflate its duration", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex", repositoryId: "project" };
    f.service.startCloudTurn({ ...input, prompt: "Check" });
    const sink = f.calls[0].sink;
    sink.session("native", "account"); sink.thinking("summary", "Inspect", true);
    sink.text("message", "Done", true, "final_answer"); sink.complete();
    const published = f.events.at(-1);
    assert.equal(published.state, "running");
    assert.equal(published.entries.at(-1).text, "Done");
    assert.equal(published.entries.at(-1).phase, "final_answer");
    const end = published.entries[0].completedAt; assert.ok(end);
    sink.usage(100000, 100); f.calls[0].resolve(); await tick();
    assert.equal(f.service.getCloudWorkspace(input).entries[0].completedAt, end);
  } finally { f.close(); }
});

test("disconnect clears only that provider's sessions and quotas, retaining chats and the other account", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex", repositoryId: "project" };
    f.service.startCloudTurn({ ...input, prompt: "Keep this chat" });
    f.calls[0].sink.session("codex-session", "codex-account");
    await assert.rejects(f.service.disconnectCloudProvider({ provider: "codex" }), /finish/);
    f.calls[0].resolve(); await tick();
    f.service.startCloudTurn({ ...input, provider: "claude", prompt: "Continue" });
    f.calls[1].sink.session("claude-session", "claude-account"); f.calls[1].resolve(); await tick();
    f.db.prepare("INSERT INTO settings VALUES (?, ?)").run("cloud:usage:codex:account", "{}");
    let release; f.runtime.signOut = () => new Promise(resolve => { release = resolve; });
    const logout = f.service.disconnectCloudProvider({ provider: "codex" });
    assert.throws(() => f.service.startCloudTurn({ ...input, prompt: "Too soon" }), /finish/i);
    release(); assert.equal((await logout).state, "sign_in");
    const workspace = f.service.getCloudWorkspace(input);
    assert.equal(workspace.sessionId, undefined); assert.equal(workspace.sessions.codex, undefined);
    assert.equal(workspace.sessions.claude, undefined);
    assert.equal(f.service.getCloudWorkspace({ ...input, provider: "claude" }).sessionId, "claude-session");
    assert.ok(workspace.entries.some(entry => entry.text === "Keep this chat"));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM settings WHERE key GLOB 'cloud:usage:codex:*'").get().n, 0);
    const stored = JSON.parse(f.db.prepare("SELECT payload FROM settings WHERE key = ?").get(`cloud:workspace:${workspace.key}`).payload);
    assert.equal(stored.sessions.codex, undefined); assert.equal(stored.sessions.claude, undefined);
  } finally { f.close(); }
});

test("failed sign-out preserves saved sessions; late inspections cannot restore disconnected quotas", async () => {
  const f = fixture();
  try {
    const input = { provider: "codex", repositoryId: "project" };
    f.service.startCloudTurn({ ...input, prompt: "Hello" });
    f.calls[0].sink.session("native", "account"); f.calls[0].resolve(); await tick();
    f.runtime.signOut = async () => { throw new Error("Sign-out failed"); };
    await assert.rejects(f.service.disconnectCloudProvider({ provider: "codex" }), /failed/);
    assert.equal(f.service.getCloudWorkspace(input).sessionId, "native");
    let release; f.runtime.inspect = () => new Promise(resolve => { release = resolve; });
    const inspection = f.service.inspectCloudProvider({ provider: "codex" });
    f.runtime.signOut = async () => {};
    await f.service.disconnectCloudProvider({ provider: "codex" });
    release({ provider: "codex", state: "ready", account: "account", models: [], usage: { fetchedAt: new Date().toISOString(), limits: [{ id: "weekly", usedPercent: 50 }] } });
    assert.equal((await inspection).state, "sign_in");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM settings WHERE key GLOB 'cloud:usage:codex:*'").get().n, 0);
  } finally { f.close(); }
});
