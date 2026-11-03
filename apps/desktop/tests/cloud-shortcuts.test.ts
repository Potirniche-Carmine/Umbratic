import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const options = { cache: new Map(), globals: { navigator: { platform: "Win32" } } };
const registry = loadTypeScriptModule(new URL("../src/renderer/keyboardShortcuts.ts", import.meta.url), options);
const { dispatchCloudShortcut } = loadTypeScriptModule(new URL("../src/renderer/cloud/useCloudShortcuts.ts", import.meta.url), options);
const { compactPath } = loadTypeScriptModule(new URL("../src/renderer/compactPath.ts", import.meta.url));

function key(key: string, extra = {}) {
  return { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...extra };
}

test("Cloud dispatches each shared action with the saved binding", () => {
  registry.setShortcutOverrides({ "composer.focus": { key: "j", primary: true } });
  const invoked: string[] = [];
  const actions = Object.fromEntries(["app.settings", "app.shortcuts", "composer.focus", "review.toggle", "dictation.toggle", "run.stop"].map(id => [id, () => invoked.push(id)]));
  for (const event of [key(","), key("/"), key("j"), key("r", { shiftKey: true }), key("d"), key(".")]) {
    assert.equal(dispatchCloudShortcut(event, actions, false), true);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(invoked, Object.keys(actions));
  assert.equal(dispatchCloudShortcut(key("l"), actions, false), false);
  registry.setShortcutOverrides({});
});

test("Cloud shortcuts do not cross a modal, repeat, IME, or already handled event", () => {
  let invoked = 0;
  const actions = { "app.settings": () => invoked++ };
  assert.equal(dispatchCloudShortcut(key(","), actions, true), false);
  for (const extra of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { shiftKey: true }]) {
    assert.equal(dispatchCloudShortcut(key(",", extra), actions, false), false);
  }
  assert.equal(invoked, 0);
});

test("Cloud documents only its available shortcuts and respects the send preference", () => {
  const rows = registry.shortcutSections("cloud", false).flatMap(group => group.rows);
  for (const id of ["chat.jump", "composer.mention"]) {
    assert.ok(!rows.some(row => row.id === id));
    assert.equal(registry.shortcutAvailable(id, "cloud"), false);
  }
  const send = rows.find(row => row.id === "composer.send");
  assert.deepEqual(Array.from(registry.shortcutKeys(send, true)), ["⌘", "Enter"]);
  assert.deepEqual(Array.from(registry.shortcutKeys(send, false)), ["Ctrl", "Enter"]);
  assert.deepEqual(Array.from(registry.shortcutKeys(registry.composerSendShortcut(true), true)), ["Enter"]);
  let created = false;
  assert.equal(dispatchCloudShortcut(key("n"), { "chat.new": () => { created = true; } }, false), true);
  assert.equal(created, true);
});

test("compact file labels keep same-name files distinguishable without exposing full paths", () => {
  assert.equal(compactPath("/tmp/App/greeting.ts"), "greeting.ts");
  assert.equal(compactPath("/tmp/App/greeting.ts", ["/tmp/App/greeting.ts", "/tmp/App/greeting.ts"]), "greeting.ts");
  const peers = ["/work/App/src/index.ts", "/work/Worker/src/index.ts"];
  assert.equal(compactPath(peers[0], peers), "App/src/index.ts");
  assert.equal(compactPath("C:\\work\\App\\index.ts", ["C:\\work\\App\\index.ts", "C:\\work\\Worker\\index.ts"]), "App/index.ts");
});
