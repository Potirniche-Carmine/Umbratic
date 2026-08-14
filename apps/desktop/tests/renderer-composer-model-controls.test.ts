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
  // Right-anchored since the picker moved into the prompt box's bottom rail.
  assert.match(menu, /transform-origin:\s*bottom right/);
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
  assert.match(controls, /title=\{disabled \? disabledReason \?\? "" : `Model: \$\{selectedLabel\}`\}/);
});

test("the composer always offers a way to reach a model", () => {
  // A second model, or a level on the one model, or local mode at all: with
  // nothing downloaded the control is the only route from the composer to
  // where models come from, so it stays.
  assert.match(main, /composerModels\.length > 1 \|\| modelReasoningEfforts\.length > 0 \|\| endpointSettings\.mode === "local" \? \(/);
  assert.match(controls, /Download a model…/);
  assert.match(controls, /"Choose a model"/);
  // The old early return would have hidden it exactly when it was needed most.
  assert.doesNotMatch(controls, /if \(models\.length === 0\) return null;/);
});

test("effort levels are the selected model's own, shown inside its menu", () => {
  // A per-model list, not a fixed four: the section is absent for a model that
  // reads no effort, rather than offering a choice its template would ignore.
  assert.match(controls, /efforts\.length > 0 \? \(/);
  assert.match(controls, /<p className="modelMenuHeading">Effort<\/p>/);
  assert.match(controls, /<p className="modelMenuHeading">Model<\/p>/);
  assert.match(main, /efforts=\{modelReasoningEfforts\}/);
  // The model list is a step in from the main page, not a wall of rows under
  // the levels.
  assert.match(controls, /setPage\("models"\)/);
  assert.match(controls, /if \(!open\) setPage\("main"\);/);
});

test("the model name carries no icon and no context window", () => {
  const trigger = controls.slice(controls.indexOf('className="modelTrigger"'), controls.indexOf("</button>", controls.indexOf('className="modelTrigger"')));
  assert.doesNotMatch(trigger, /<Cpu/);
  assert.doesNotMatch(controls, /modelContextBadge/);
  assert.doesNotMatch(controls, /contextBadge\?:/);
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
