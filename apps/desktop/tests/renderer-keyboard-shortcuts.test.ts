import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../src/renderer/keyboardShortcuts.ts");

function loadTypeScriptModule(filePath) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    { console, exports: module.exports, module, require, navigator: { platform: "Linux x86_64" } },
    { filename: filePath },
  );
  return module.exports;
}

const {
  bindingFromEvent,
  conflictingShortcut,
  dictationToggleShortcut,
  matchesShortcut,
  setShortcutOverrides,
  shortcutOverrides,
  shortcutById,
  shortcutForEvent,
  shortcutKeys,
  shortcutLabel,
  shortcutSections,
  shortcuts,
  titleWithShortcut,
  usableBinding,
} = loadTypeScriptModule(modulePath);

const keyEvent = (key: string, modifiers: Record<string, boolean> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

test("the dictation chord is the platform's primary modifier and nothing else", () => {
  // D for dictation, Command on a Mac and Control everywhere else. The other
  // platform's modifier is never part of a chord here, so holding it means
  // this is some other shortcut.
  assert.equal(dictationToggleShortcut().key, "d");
  assert.equal(matchesShortcut(keyEvent("d", { metaKey: true }), dictationToggleShortcut(), true), true);
  assert.equal(matchesShortcut(keyEvent("d", { ctrlKey: true }), dictationToggleShortcut(), true), false);
  assert.equal(matchesShortcut(keyEvent("d", { ctrlKey: true }), dictationToggleShortcut(), false), true);
  assert.equal(matchesShortcut(keyEvent("d", { metaKey: true }), dictationToggleShortcut(), false), false);
  // Case is the keyboard's business, not the shortcut's.
  assert.equal(matchesShortcut(keyEvent("D", { metaKey: true }), dictationToggleShortcut(), true), true);
});

test("a chord with extra modifiers is a different chord", () => {
  // Matching loosely would swallow combinations the app was never given,
  // including ones the user's own system has assigned.
  for (const extra of [{ altKey: true }, { ctrlKey: true }]) {
    assert.equal(
      matchesShortcut(keyEvent("d", { metaKey: true, ...extra }), dictationToggleShortcut(), true),
      false,
    );
  }
  assert.equal(matchesShortcut(keyEvent("d"), dictationToggleShortcut(), true), false);
  assert.equal(matchesShortcut(keyEvent("j", { metaKey: true }), dictationToggleShortcut(), true), false);
  // And Shift is what separates "show review" from a plain reload chord.
  assert.equal(shortcutForEvent(keyEvent("r", { metaKey: true, shiftKey: true }), true).id, "review.toggle");
  assert.equal(shortcutForEvent(keyEvent("r", { metaKey: true }), true), null);
});

test("every installed chord is unique and dispatchable", () => {
  const bound = shortcuts.filter((row) => row.binding);
  // Two shortcuts on one chord means one of them silently never fires.
  const chords = bound.map((row) => shortcutLabel(row, true));
  assert.equal(new Set(chords).size, chords.length, `duplicate chord in ${chords.join(", ")}`);
  // Each one is found by the event it claims, on both platforms.
  for (const row of bound) {
    for (const mac of [true, false]) {
      const event = keyEvent(row.binding.key, {
        metaKey: mac && !!row.binding.primary,
        ctrlKey: !mac && !!row.binding.primary,
        shiftKey: !!row.binding.shift,
        altKey: !!row.binding.alt,
      });
      assert.equal(shortcutForEvent(event, mac)?.id, row.id, `${row.id} should match its own chord`);
    }
  }
});

test("shortcuts are spelled for the machine that reads them", () => {
  // `Array.from` because the module runs in its own vm realm: an array built
  // there has that realm's prototype, which a strict deep comparison rejects.
  const keys = (...args: unknown[]) => Array.from(shortcutKeys(...args) as string[]);
  const toggle = shortcutById("dictation.toggle");
  // The Mac gets the glyph that is printed on its own key.
  assert.deepEqual(keys(toggle, true), ["⌘", "D"]);
  assert.deepEqual(keys(toggle, false), ["Ctrl", "D"]);
  assert.equal(shortcutLabel(toggle, true), "⌘D");
  assert.equal(shortcutLabel(toggle, false), "Ctrl+D");
  assert.deepEqual(keys(shortcutById("review.toggle"), true), ["⌘", "⇧", "R"]);
  assert.deepEqual(keys(shortcutById("review.toggle"), false), ["Ctrl", "Shift", "R"]);
  // Reference rows print the key they document rather than inventing a chord.
  assert.deepEqual(keys(shortcutById("composer.send"), true), ["Enter"]);
  // Tooltips carry the chord, which is the only way anyone finds it.
  assert.equal(titleWithShortcut("New chat", "chat.new", true), "New chat (⌘N)");
  assert.equal(titleWithShortcut("New chat", "chat.new", false), "New chat (Ctrl+N)");
  // Every row lands in a section, or the settings page would silently drop it.
  const listed = shortcutSections().flatMap((group) => group.rows);
  assert.equal(listed.length, shortcuts.length);
});

test("the shortcuts that fire and the shortcuts that are documented are one table", () => {
  const main = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  // One listener dispatching by id, not a pile of key literals that drift.
  assert.match(main, /const shortcut = shortcutForEvent\(event\)/);
  assert.doesNotMatch(main, /event\.key === "k"/);
  // On capture, because the composer textarea has focus almost all the time.
  assert.match(main, /addEventListener\("keydown", runShortcut, true\)/);
  // Never past a dialog to a window the user cannot see, and never on the
  // auto-repeat of a held key.
  assert.match(main, /if \(shortcutsBlockedRef\.current \|\| event\.repeat \|\| event\.isComposing\) return/);
  assert.match(main, /shortcutsBlockedRef\.current = modalOpen/);
  // The actions are read through a ref and rewritten every render, so the one
  // listener always calls today's closures rather than the render it
  // subscribed on — a stale one would act on an old copy of the composer.
  assert.match(main, /shortcutActionsRef\.current\[shortcut\.id\]/);
  assert.match(main, /document\.addEventListener\("keydown", runShortcut, true\);\n    return \(\) => document\.removeEventListener\("keydown", runShortcut, true\);\n  \}, \[\]\)/);
  // Each installed chord has something to run.
  for (const id of ["dictation.toggle", "chat.new", "app.settings", "app.shortcuts", "review.toggle", "composer.focus", "run.stop"]) {
    assert.ok(main.includes(`"${id}":`), `main.tsx should handle ${id}`);
  }
  // Stopping is guarded: nothing to stop, or a stop already landing, and the
  // key does nothing rather than firing a second cancel.
  assert.match(main, /if \(isGenerating && !stopPending\) void stopTask\(\)/);
  // The controls that duplicate a chord say so on hover, in the app's own
  // tooltip rather than the platform's — and none of them carries a `title` as
  // well, which would show a second, slower tooltip a beat behind the first.
  const composerControls = fs.readFileSync(new URL("../src/renderer/ComposerControls.tsx", import.meta.url), "utf8");
  for (const call of [
    /<ShortcutTooltip id="chat\.new"/,
    /<ShortcutTooltip id="app\.settings">/,
    /<ShortcutTooltip id="run\.stop" label="Stop generation" disabled=\{stopPending\}>/,
    /<ShortcutTooltip\s+id="review\.toggle"/,
    /<ShortcutTooltip id="composer\.send" label="Send prompt">/,
  ]) {
    assert.match(main, call);
  }
  assert.match(composerControls, /<ShortcutTooltip id="dictation\.toggle" label=\{label\} disabled=\{busy\}>/);
  assert.doesNotMatch(main, /titleWithShortcut/);
  assert.doesNotMatch(composerControls, /shortcutTitle|title="Choose microphone"/);

  const nav = fs.readFileSync(new URL("../src/renderer/SettingsNav.tsx", import.meta.url), "utf8");
  assert.match(nav, /id: "keyboard", label: "Keyboard"/);
  assert.match(main, /settingsTab === "keyboard" \? <KeyboardSettingsPanel api=\{api\} \/> : null/);
});

test("a rebound chord replaces the shipped one everywhere at once", () => {
  // The listener, the tooltips and the settings page all read one table, so a
  // change cannot leave a control advertising a key that stopped working.
  setShortcutOverrides({ "chat.new": { key: "t", primary: true } });
  assert.equal(shortcutById("chat.new").binding.key, "t");
  assert.equal(shortcutLabel(shortcutById("chat.new"), true), "⌘T");
  assert.equal(shortcutForEvent(keyEvent("t", { metaKey: true }), true)?.id, "chat.new");
  // And the chord it replaced no longer fires.
  assert.equal(shortcutForEvent(keyEvent("n", { metaKey: true }), true), null);
  // The settings page reads the same table, or it would document the old chord.
  const documented = shortcutSections().flatMap((group) => group.rows).find((row) => row.id === "chat.new");
  assert.equal(documented.binding.key, "t");

  // Only the difference is stored. Keeping the whole table would pin every
  // default to the version that wrote it.
  assert.deepEqual(Object.keys(shortcutOverrides()), ["chat.new"]);
  setShortcutOverrides({});
  assert.equal(shortcutById("chat.new").binding.key, "n");
});

test("a stored binding that cannot be dispatched is dropped rather than installed", () => {
  setShortcutOverrides({
    // An id from a version of this table that no longer exists.
    "chat.ancient": { key: "q", primary: true },
    // A bare letter, which would fire every time it was typed into the prompt.
    "chat.new": { key: "t" },
    // A modifier is not a chord of its own.
    "app.settings": { key: "Shift", primary: true },
    // And a row the app does not install cannot be given a chord here.
    "composer.send": { key: "j", primary: true },
  });
  assert.deepEqual(Object.keys(shortcutOverrides()), []);
  assert.equal(shortcutById("chat.new").binding.key, "n");
});

test("the recorder refuses what the listener could never match", () => {
  // Modifierless chords: the listener runs on capture, ahead of the prompt box.
  assert.equal(bindingFromEvent(keyEvent("t"), true), null);
  assert.equal(usableBinding({ key: "t" }), false);
  assert.equal(usableBinding({ key: "t", alt: true }), true);
  // The other platform's modifier is never part of a chord, so a chord recorded
  // with it held could never be matched back.
  assert.equal(bindingFromEvent(keyEvent("t", { metaKey: true, ctrlKey: true }), true), null);
  // Case is the keyboard's business: ⇧T and T record the same key.
  // Spread into this realm: the module runs in its own, and a strict deep
  // comparison rejects an object carrying the other realm's prototype.
  assert.deepEqual({ ...bindingFromEvent(keyEvent("T", { metaKey: true, shiftKey: true }), true) }, {
    key: "t",
    primary: true,
    shift: true,
  });
  // Named keys keep their name.
  assert.equal(bindingFromEvent(keyEvent("Enter", { metaKey: true }), true).key, "Enter");
});

test("two shortcuts cannot be given the same chord", () => {
  // One of them would silently never fire, so the editor names the row already
  // holding the chord instead of taking it away.
  assert.equal(conflictingShortcut("chat.new", { key: ",", primary: true })?.id, "app.settings");
  assert.equal(conflictingShortcut("app.settings", { key: ",", primary: true }), null);
  assert.equal(conflictingShortcut("chat.new", { key: "y", primary: true }), null);
});

test("the keyboard page edits the table it prints", () => {
  const panel = fs.readFileSync(new URL("../src/renderer/KeyboardSettings.tsx", import.meta.url), "utf8");
  // In force first, written second: the write can fail, and a key that works
  // until the next launch is a better answer than one that refuses to work now.
  const save = panel.slice(panel.indexOf("const save = useCallback"), panel.indexOf("const record = useCallback"));
  assert.ok(save.indexOf("setShortcutOverrides(next)") < save.indexOf("api.saveKeyBindings(next"));
  // Recorded on capture, or a chord the window owns would never reach the page.
  assert.match(panel, /window\.addEventListener\("keydown", listen, true\)/);
  // Modifiers alone are not chords, which is what lets the recorder sit open
  // while somebody holds Command and decides what to press with it.
  assert.match(panel, /\["Shift", "Control", "Alt", "Meta"\]\.includes\(event\.key\)/);
  assert.match(panel, /if \(event\.key === "Escape"\)/);
  // A chord recorded back onto its own default is not an override.
  assert.match(panel, /if \(shipped && sameBinding\(shipped, binding\)\) delete next\[id\]/);
  // Reference-only rows are printed, not offered as editable.
  assert.match(panel, /const editable = !!row\.binding/);
  assert.doesNotMatch(panel, /These cannot be changed yet/);
});
