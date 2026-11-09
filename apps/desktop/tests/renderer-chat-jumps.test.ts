import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture(platform) {
  const values = []; const deps = []; const cleanups = []; const events = new Map(); let cursor = 0;
  let overlay = false;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
    useEffect(fn, next) {
      const i = cursor++;
      if (deps[i] && next.length === deps[i].length && next.every((v, j) => Object.is(v, deps[i][j]))) return;
      cleanups[i]?.(); cleanups[i] = fn(); deps[i] = next;
    },
  };
  const source = scope => ({
    addEventListener(type, fn, capture) { events.set(`${scope}:${type}:${!!capture}`, { fn, capture }); },
    removeEventListener(type, fn, capture) { events.delete(`${scope}:${type}:${!!capture}`); },
  });
  const options = { cache: new Map(), realm: "host", mocks: { react: hooks }, globals: {
    navigator: { platform }, document: { ...source("document"), querySelectorAll: () => overlay ? [{ checkVisibility: () => true }] : [] }, window: source("window"),
  } };
  const { useChatJumpShortcuts } = loadTypeScriptModule(new URL("../src/renderer/useChatJumpShortcuts.ts", import.meta.url), options);
  const { useWorkspaceShortcuts } = loadTypeScriptModule(new URL("../src/renderer/useWorkspaceShortcuts.ts", import.meta.url), options);
  return {
    render(targets, select, blocked = false) { cursor = 0; return useChatJumpShortcuts(targets, select, blocked); },
    cloud(actions, blocked = false) { cursor = 0; useWorkspaceShortcuts(actions, { mode: "cloud", blocked }); },
    overlay(value) { overlay = value; },
    emit(type, extra = {}) {
      const listener = events.get(`${type === "blur" ? "window" : "document"}:${type}:${type !== "blur"}`);
      assert.ok(listener, type); if (type !== "blur") assert.equal(listener.capture, true, "shortcuts run before the composer handles the key");
      const event = { type, key: "Meta", metaKey: platform === "MacIntel", ctrlKey: platform !== "MacIntel", altKey: false, shiftKey: false,
        repeat: false, isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      listener.fn(event); return event;
    },
    cleanup() { cleanups.forEach(fn => fn?.()); assert.equal(events.size, 0); },
  };
}

for (const platform of ["MacIntel", "Win32"]) {
  test(`${platform} chat numbers track the modifier, visible targets, and focus`, t => {
    const f = fixture(platform); t.after(f.cleanup); const selected = []; const select = value => selected.push(value);
    const targets = ["first", "second"];
    assert.equal(f.render(targets, select), false);
    f.emit("keydown"); assert.equal(f.render(targets, select), true);
    assert.equal(f.emit("keydown", { key: "2" }).defaultPrevented, true); assert.deepEqual(selected, ["second"]);
    assert.equal(f.render(targets, select), true);
    for (const extra of [{ key: "3" }, { key: "1", repeat: true }, { key: "1", isComposing: true }, { key: "1", altKey: true }, { key: "1", defaultPrevented: true }]) f.emit("keydown", extra);
    assert.deepEqual(selected, ["second"]);
    f.render(["filtered"], select); f.emit("keydown", { key: "1" }); assert.deepEqual(selected, ["second", "filtered"]);
    f.emit("keyup", { metaKey: false, ctrlKey: false }); assert.equal(f.render(targets, select), false);
    f.emit("keydown"); f.emit("blur"); assert.equal(f.render(targets, select), false);
    f.overlay(true); f.emit("keydown", { key: "1" }); assert.equal(f.render(targets, select), false);
    f.overlay(false); f.render(targets, select, true); f.emit("keydown", { key: "1" }); assert.equal(f.render(targets, select, true), false);
    assert.deepEqual(selected, ["second", "filtered"]);
    assert.equal(f.render(targets, select, false), true, "numbers return after a chat load while the modifier is still held");
  });

  test(`${platform} delete shortcut captures the composer chord and respects overlays`, t => {
    const f = fixture(platform); t.after(f.cleanup); let deleted = 0;
    f.cloud({ "chat.delete": () => deleted++ });
    assert.equal(f.emit("keydown", { key: "Backspace", shiftKey: true }).defaultPrevented, true);
    assert.equal(deleted, 1);
    f.overlay(true); assert.equal(f.emit("keydown", { key: "Backspace", shiftKey: true }).defaultPrevented, false);
    assert.equal(deleted, 1);
  });
}
