import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controls = readFileSync(new URL("../src/renderer/ComposerControls.tsx", import.meta.url), "utf8");
const combobox = readFileSync(new URL("../src/renderer/ModelCombobox.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/renderer/styles/model-controls.css", import.meta.url), "utf8");
const stylesIndex = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  assert.ok(match?.groups?.body, `${selector} should be styled`);
  return match.groups.body;
}

test("the composer controls stylesheet is actually loaded", () => {
  assert.match(stylesIndex, /@import "\.\/styles\/model-controls\.css";/);
});

test("the Think toggle reports its state to assistive technology and to the eye", () => {
  assert.match(controls, /aria-pressed=\{on\}/);
  assert.match(controls, /Thinking forced on — model reasons before answering/);
  assert.match(controls, /Thinking off — model answers directly/);
  // Disabled with an explanation rather than silently inert.
  assert.match(controls, /This model does not reason before answering/);
  assert.match(controls, /disabled=\{disabled \|\| !supported\}/);
});

test("the Think toggle matches the composer pill grammar and presses in on touch-down", () => {
  const pill = declarations(".thinkToggle");
  assert.match(pill, /height:\s*28px/);
  assert.match(pill, /padding:\s*0 9px/);
  assert.match(pill, /border-radius:\s*999px/);
  assert.match(pill, /font-size:\s*12px/);
  // Feedback belongs to the press, so the transform transition is the fast one.
  assert.match(pill, /transform 100ms ease-out/);
  assert.match(declarations(".thinkToggle:active:not(:disabled)"), /transform:\s*scale\(0\.97\)/);
  // On borrows the composer's existing engaged look rather than inventing a
  // state colour, and it has to be visible: the reasoning tokens are tuned to
  // make text recede and left on and off four values apart.
  const on = declarations(".thinkControl.isOn .thinkToggle");
  assert.match(on, /color:\s*var\(--text\)/);
  assert.match(on, /border-color:\s*var\(--line-strong\)/);
  assert.match(on, /background:\s*var\(--control-active\)/);
});

test("the model menu grows upward from the trigger it belongs to", () => {
  const menu = declarations(".modelMenu");
  assert.match(menu, /bottom:\s*calc\(100% \+ 7px\)/);
  assert.match(menu, /min-width:\s*240px/);
  assert.match(menu, /transform-origin:\s*bottom left/);
  assert.match(menu, /animation:\s*menuRise 180ms ease both/);
});

test("reduced motion swaps the rise for a fade and drops the press transform", () => {
  const reduced = styles.match(/@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.match(reduced, /animation:\s*menuFade 120ms ease both/);
  assert.match(reduced, /transform:\s*none/);
  assert.match(styles, /@keyframes menuFade/);
});

test("menu rows are radio items and a stopped model stays visible and selectable", () => {
  assert.match(controls, /role="menuitemradio"/);
  assert.match(controls, /aria-checked=\{model\.id === selectedId\}/);
  assert.match(controls, /This model is registered but not running/);
  // Dimmed, not hidden, and with no `disabled` attribute.
  assert.match(declarations(".modelMenu button.isStopped"), /opacity:\s*0\.55/);
  assert.match(declarations(".modelMenu button.isStopped .modelStatusDot"), /var\(--muted\)/);
  assert.match(declarations(".modelPickerOption.isStopped .modelPickerStatusDot"), /var\(--muted\)/);
});

test("the picker disables itself during a run and says why", () => {
  assert.match(main, /disabledReason="Wait for the current run to finish"/);
  assert.match(controls, /title=\{disabled \? disabledReason \?\? "" : `Model: \$\{selected\?\.label \?\? selectedId\}`\}/);
});

test("the composer offers a choice only where one exists", () => {
  // One model is not a choice: the picker is absent rather than showing a menu
  // with a single row.
  assert.match(main, /composerModels\.length > 1 \? \(/);
  assert.match(controls, /if \(models\.length === 0\) return null;/);
  // Server mode has to hear the feature name before the toggle claims to work.
  assert.match(main, /endpointSettings\.mode === "local"\s*\n\s*\|\| \(backend\?\.veilFeatures \?\? \[\]\)\.includes\("chat\.thinking_toggle"\)/);
});

test("both model lists are the same control", () => {
  assert.match(combobox, /export function ModelCombobox/);
  assert.match(combobox, /role="combobox"/);
  assert.match(combobox, /role="listbox"/);
  assert.match(combobox, /role="option"/);
  // Keyboard navigation lives in the shared control, not in either caller.
  assert.match(combobox, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  // A selection the list no longer offers is kept, not silently replaced.
  assert.match(combobox, /!items\.some\(\(item\) => item\.id === selectedId\)/);
});

test("context windows are labelled the way the menu shows them", () => {
  // Evaluated from source rather than imported: the module is TSX, and this
  // helper is plain arithmetic that does not need React to be loaded.
  const source = controls.slice(controls.indexOf("export function contextBadge"));
  const body = source.slice(source.indexOf("{"), source.indexOf("\n}") + 2);
  const contextBadge = new Function(`return function contextBadge(contextLength) ${body}`)();
  assert.equal(contextBadge(98_304), "98k");
  assert.equal(contextBadge(1_000_000), "1.0M");
  assert.equal(contextBadge(512), "512");
  assert.equal(contextBadge(0), undefined);
  assert.equal(contextBadge(undefined), undefined);
});
