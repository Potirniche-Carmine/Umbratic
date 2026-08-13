import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controls = readFileSync(new URL("../src/renderer/ComposerControls.tsx", import.meta.url), "utf8");
const combobox = readFileSync(new URL("../src/renderer/Combobox.tsx", import.meta.url), "utf8");
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
});

test("every settings dropdown is the same control", () => {
  assert.match(combobox, /export function Combobox/);
  assert.match(combobox, /role="combobox"/);
  assert.match(combobox, /role="listbox"/);
  assert.match(combobox, /role="option"/);
  // Keyboard navigation lives in the shared control, not in either caller.
  assert.match(combobox, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  // A selection the list no longer offers is kept, not silently replaced.
  assert.match(combobox, /!items\.some\(\(item\) => item\.id === selectedId\)/);

  // A native <select> draws in the operating system's colours, not the app's,
  // so no settings page may fall back to one.
  for (const file of ["ConnectionSettings.tsx", "RemoteSettings.tsx", "AppearanceSettings.tsx"]) {
    const source = readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /<select\b/, `${file} should use Combobox rather than a native select`);
  }
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
