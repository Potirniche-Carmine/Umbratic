import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture(storage = new Map()) {
  const values = []; const deps = []; const cleanups = [];
  let cursor = 0; let effects = []; let focused = true;
  const events = new Map<string, Set<() => void>>();
  const listeners = {
    addEventListener(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); },
    removeEventListener(name, listener) { events.get(name)?.delete(listener); },
  };
  const document = { ...listeners, visibilityState: "visible", hasFocus: () => focused };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in values)) values[i] = typeof initial === "function" ? initial() : initial;
      return [values[i], next => { values[i] = typeof next === "function" ? next(values[i]) : next; }];
    },
    useEffect(fn, next) {
      const i = cursor++;
      if (!deps[i] || next.some((value, j) => !Object.is(value, deps[i][j]))) {
        deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
      }
    },
  };
  const { useChatReadState } = loadTypeScriptModule(new URL("../src/renderer/useChatReadState.ts", import.meta.url), {
    realm: "host", mocks: { react: hooks }, globals: { document, window: { ...listeners,
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    } },
  });
  return {
    storage,
    render(chats, selected = null, visible = true, scope = "codex") {
      cursor = 0;
      const unread = useChatReadState(scope, chats, selected, visible);
      const pending = effects; effects = []; pending.forEach(effect => effect());
      return [...unread];
    },
    focus(value) { focused = value; events.get(value ? "focus" : "blur")?.forEach(listener => listener()); },
    hide(value) { document.visibilityState = value ? "hidden" : "visible"; events.get("visibilitychange")?.forEach(listener => listener()); },
    cleanup() { cleanups.forEach(cleanup => cleanup?.()); assert.ok([...events.values()].every(listeners => !listeners.size)); },
  };
}
const chat = (id, updatedAt = "first", state = "idle") => ({ id, updatedAt, state });

test("opening a completed chat clears only its unread reply and remembers it after reopening the app", t => {
  const f = fixture(); t.after(f.cleanup);
  const rows = [chat("one"), chat("two")];
  assert.deepEqual(f.render(rows), ["one", "two"]);
  assert.deepEqual(f.render(rows, "one"), ["two"]);
  assert.deepEqual(f.render(rows), ["two"]);
  const reopened = fixture(f.storage); t.after(reopened.cleanup);
  assert.deepEqual(reopened.render(rows), ["two"]);
  assert.deepEqual(reopened.render(rows, "two"), []);
  // Reading the second chat must also retain the first chat's stored revision.
  assert.deepEqual(reopened.render(rows), []);
});

test("background providers and unfocused or hidden windows do not mark a reply read", t => {
  const f = fixture(); t.after(f.cleanup); const rows = [chat("one")];
  assert.deepEqual(f.render(rows, "one", false), ["one"]);
  f.focus(false); assert.deepEqual(f.render(rows, "one"), ["one"]);
  f.focus(true); f.hide(true); assert.deepEqual(f.render(rows, "one"), ["one"]);
  f.hide(false); assert.deepEqual(f.render(rows, "one"), []);
  assert.deepEqual(f.render(rows, null, false), []);
});

test("a later reply becomes unread again, while a reply completed in view stays read", t => {
  const f = fixture(); t.after(f.cleanup);
  assert.deepEqual(f.render([chat("one")], "one"), []);
  assert.deepEqual(f.render([chat("one", "second", "running")]), []);
  assert.deepEqual(f.render([chat("one", "second")]), ["one"]);
  assert.deepEqual(f.render([chat("one", "second")], "one"), []);
  assert.deepEqual(f.render([chat("one", "third")], "one"), []);
  assert.deepEqual(f.render([chat("one", "third")]), []);
  assert.deepEqual(f.render([chat("one", "fourth", "waiting")]), []);
});

test("read state is separate for ChatGPT, Claude, and local chats and tolerates damaged storage", t => {
  const storage = new Map([["umbratic.read-chats.local", "not JSON"]]);
  const local = fixture(storage); t.after(local.cleanup);
  assert.deepEqual(local.render([chat("one")], "one", true, "local"), []);
  for (const provider of ["codex", "claude"]) {
    const f = fixture(storage); t.after(f.cleanup);
    assert.deepEqual(f.render([chat("one")], null, true, provider), ["one"]);
  }
});
