import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const workspace = (key, provider = "codex") => ({ key, chatId: key, provider, path: "/project", paths: ["/project"], state: "idle", entries: [], approvals: [], compactions: 0 });
function fixture(provider = "codex", overrides = {}) {
  const values = []; const deps = []; const cleanups = []; let cursor = 0; let effects = [];
  const listeners = new Set(); const errors = []; const storage = new Map(); let created = 0;
  const same = (a, b) => a && a.length === b.length && b.every((value, i) => Object.is(value, a[i]));
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === "function" ? initial() : initial; return [values[i], next => { values[i] = typeof next === "function" ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
    useCallback(fn, next) { const i = cursor++; if (!same(deps[i], next)) { values[i] = fn; deps[i] = next; } return values[i]; },
    useEffect(fn, next) { const i = cursor++; if (!same(deps[i], next)) { deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const api = {
    listCloudChats: async () => [],
    getCloudWorkspace: async input => workspace(input.key || "first", input.provider),
    createCloudChat: async input => workspace(created++ ? `new-${created}` : "first", input.provider),
    deleteCloudChat: async () => undefined,
    onCloudWorkspace: listener => { listeners.add(listener); return () => listeners.delete(listener); }, ...overrides,
  };
  const { useCloudChats } = loadTypeScriptModule(new URL("../src/renderer/cloud/useCloudChats.ts", import.meta.url), { realm: "host", mocks: { react: hooks }, globals: {
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  } });
  return {
    errors, storage,
    render() { cursor = 0; const result = useCloudChats(api, provider, ["project"], message => errors.push(message)); const pending = effects; effects = []; pending.forEach(fn => fn()); return result; },
    publish(value) { listeners.forEach(listener => listener(value)); },
    cleanup() { cleanups.forEach(fn => fn?.()); },
  };
}

test("switching chats preserves independent prompts, attachments, and review comments", async t => {
  const f = fixture(); t.after(f.cleanup); f.render(); await tick();
  let chat = f.render(); chat.setPrompt("Unsent first draft"); chat.setImages([{ id: "first-image" }]); chat.setFeedback([{ id: "review-comment" }]);
  await f.render().open({ provider: "codex", key: "second" });
  chat = f.render(); assert.equal(chat.prompt, ""); assert.deepEqual(chat.images, []); assert.deepEqual(chat.feedback, []);
  chat.setPrompt("Unsent second draft"); f.render();
  await f.render().open({ provider: "codex", key: "first" });
  chat = f.render(); assert.equal(chat.prompt, "Unsent first draft"); assert.equal(chat.images[0].id, "first-image"); assert.equal(chat.feedback[0].id, "review-comment");
  assert.equal(f.storage.get("umbratic.active-chat.codex"), "first");
  await chat.open({ provider: "codex", key: "second" }); assert.equal(f.render().prompt, "Unsent second draft");
});

test("streaming updates stay with their provider and selected chat", async t => {
  const f = fixture(); t.after(f.cleanup); f.render(); await tick(); f.render();
  f.publish({ ...workspace("claude-chat", "claude"), state: "running" });
  assert.equal(f.render().chats.some(chat => chat.provider === "claude"), false);
  f.publish({ ...workspace("background"), state: "waiting", entries: [{ kind: "instruction", text: "Background task" }] });
  assert.equal(f.render().workspace.key, "first"); assert.equal(f.render().chats.find(chat => chat.key === "background").state, "waiting");
  f.publish({ ...workspace("first"), entries: [{ kind: "answer", text: "Current answer" }] });
  assert.equal(f.render().workspace.entries[0].text, "Current answer");
});

test("a late chat load cannot overwrite a newer selection or its draft", async t => {
  let release;
  const f = fixture("codex", { getCloudWorkspace: input => input.key === "slow" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(workspace(input.key || "first")) });
  t.after(f.cleanup); f.render(); await tick(); f.render().setPrompt("First draft"); f.render();
  const stale = f.render().open({ provider: "codex", key: "slow" });
  await f.render().open({ provider: "codex", key: "latest" });
  f.render().setPrompt("Latest draft"); f.render();
  release(workspace("slow")); await stale;
  assert.equal(f.render().workspace.key, "latest"); assert.equal(f.render().prompt, "Latest draft");
});

test("failed selection keeps the current chat and draft available", async t => {
  const f = fixture("codex", { getCloudWorkspace: async input => { if (input.key === "missing") throw new Error("Open the folder again"); return workspace("first"); } });
  t.after(f.cleanup); f.render(); await tick(); f.render().setPrompt("Keep this"); f.render();
  await f.render().open({ provider: "codex", key: "missing" });
  assert.equal(f.render().workspace.key, "first"); assert.equal(f.render().prompt, "Keep this"); assert.equal(f.render().loading, false);
  assert.deepEqual(f.errors, ["Open the folder again"]);
});

test("an initial unsent draft stays reachable after creating and deleting another chat", async t => {
  const f = fixture(); t.after(f.cleanup); f.render(); await tick();
  let chat = f.render(); assert.equal(chat.chats[0].key, "first");
  chat.setPrompt("Keep my initial draft"); f.render();
  await f.render().open({ provider: "codex" }, true);
  chat = f.render(); const added = chat.workspace.key;
  assert.equal(chat.chats.length, 2); assert.equal(chat.prompt, "");
  await chat.remove(added);
  chat = f.render(); assert.equal(chat.workspace.key, "first"); assert.equal(chat.prompt, "Keep my initial draft");
  await chat.remove("first");
  chat = f.render(); assert.equal(chat.chats.length, 1); assert.notEqual(chat.workspace.key, "first"); assert.equal(chat.prompt, "");
});

test("resetting an unnamed legacy chat removes its stale archive title", async t => {
  const f = fixture(); t.after(f.cleanup); f.render(); await tick(); f.render();
  f.publish({ ...workspace("legacy"), chatId: undefined, entries: [{ kind: "instruction", text: "Old title" }] });
  assert.equal(f.render().chats.some(chat => chat.key === "legacy"), true);
  f.publish({ ...workspace("legacy"), chatId: undefined });
  assert.equal(f.render().chats.some(chat => chat.key === "legacy"), false);
});
