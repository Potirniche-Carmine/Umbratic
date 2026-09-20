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
  // Show thinking lives in General settings now, not in the model menu: it is
  // an app preference, not a property of the selected model.
  assert.doesNotMatch(controls, /Show thinking/);
  assert.match(declarations(".modelMenuHeading"), /text-transform:\s*uppercase/);
  assert.match(declarations(".modelMenu button"), /color:\s*var\(--text\)/);
  assert.match(controls, /<p className="modelMenuHeading">Model<\/p>/);
  assert.match(main, /efforts=\{modelReasoningEfforts\}/);
  // The model list is a step in from the main page, not a wall of rows under
  // the levels.
  assert.match(controls, /setPage\("models"\)/);
  // Closing puts it back on the main page, so it never reopens on a sub-page
  // the user did not leave it on.
  assert.match(controls, /if \(!open\) \{\s*\n\s*placedRef\.current = false;\s*\n\s*setPage\("main"\);/);
  // Except with nothing chosen yet, where the list is the only page worth
  // showing: making someone press "Choose a model" and then "Model ›" is two
  // clicks to answer a question the trigger already asked. Once per opening,
  // so Back still works.
  assert.match(controls, /if \(placedRef\.current \|\| !unchosen \|\| models\.length === 0\) return;/);
  assert.match(controls, /placedRef\.current = true;\s*\n\s*setPage\("models"\);/);
});

test("the checked level is the one the model is really thinking at", () => {
  // The stored effort is one setting across every model while each model
  // grades thinking its own way, so the stored level is often not one the
  // selected model reads — "medium" on a model that only knows on and off.
  // Passing it straight to the menu checked no row at all, leaving the
  // composer silent about whether the thing was thinking. Both sides resolve
  // through the same shared helper the runtime starts the model with.
  assert.match(main, /resolveReasoningEffort\(modelReasoningEfforts, reasoningEffort\) \?\? reasoningEffort/);
  assert.match(main, /effort=\{activeReasoningEffort\}/);
  assert.doesNotMatch(main, /effort=\{reasoningEffort\}/);
  const shared = readFileSync(new URL("../src/shared/modelReasoning.ts", import.meta.url), "utf8");
  assert.match(shared, /export function resolveReasoningEffort\(/);
  // One resolver, so the menu can never check a level the runtime is not using.
  const modelCatalog = readFileSync(new URL("../src/main/modelCatalog.ts", import.meta.url), "utf8");
  assert.match(modelCatalog, /return resolveReasoningEffort\(model\.reasoningEfforts, effort\);/);

  // Pressing the level already in force is not a change: saving it would
  // restart the local stack for nothing and would write this model's coarser
  // grading over a level another model reads more finely.
  assert.match(controls, /if \(level === effort\) return;/);
});

test("controls this chat can never use are gone, not greyed out", () => {
  // A chat that started without a folder can never be given one, and a chat
  // that has started keeps the host it started on. Both used to sit in the
  // rail dimmed and padlocked — a dead button is a question the user keeps
  // re-asking.
  assert.match(main, /\{chatStartedWithoutFolder \? null : \(/);
  assert.match(main, /\{task \? null : \(\s*\n\s*<RemoteHostPicker/);
  // The host is still named where it matters, above the messages.
  assert.match(main, /<RemoteChatBadge name=\{remoteBadge\.name\}/);
  // Nothing is left behind to draw a padlock with.
  const remote = readFileSync(new URL("../src/renderer/RemoteControls.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(remote, /locked/);
  assert.doesNotMatch(remote, /Lock/);
  // A run is different: it lifts in a moment, and a control that vanished for
  // its length would move every other control in the row twice.
  assert.match(main, /className="workspaceControl"[\s\S]*?disabled=\{busy\}/);
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
