import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function panel(state, api) {
  let slot = 0;
  const updates = [];
  const status = { installedVersion: "0.0.1", automatic: false, checkedAt: null, state };
  const { AboutSettingsPanel } = loadTypeScriptModule(new URL("../src/renderer/AboutSettings.tsx", import.meta.url), {
    mocks: { react: {
      useState: () => [slot++ === 0 ? status : 0, (next) => updates.push(next)],
      useEffect: () => {},
    } },
  });
  const buttons = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === "button") buttons.push(node);
    visit(node.props?.children);
  }
  visit(AboutSettingsPanel({ api }));
  return { buttons, updates };
}

test("About checks updates on demand without changing the automatic preference", async () => {
  const checked = { installedVersion: "0.0.1", automatic: false, checkedAt: new Date().toISOString(), state: { phase: "current" } };
  let calls = 0;
  const { buttons, updates } = panel({ phase: "idle" }, { checkForAppUpdate: async () => { calls++; return checked; } });
  const check = buttons.find((button) => button.props.className.includes("aboutCheck"));
  assert.equal(check.props.disabled, false);
  check.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(updates.at(-1), checked);
  assert.equal(checked.automatic, false);
});

test("About prevents concurrent checks and keeps restart for a ready release", () => {
  for (const phase of ["checking", "downloading", "unsupported"]) {
    const { buttons } = panel({ phase }, {});
    assert.equal(buttons.find((button) => button.props.className.includes("aboutCheck")).props.disabled, true);
  }
  let installs = 0;
  const { buttons } = panel({ phase: "ready", latestVersion: "0.0.2" }, { installAppUpdate: () => installs++ });
  assert.ok(buttons.every((button) => !button.props.className.includes("aboutCheck")));
  buttons.find((button) => button.props.className === "settingsInlineButton").props.onClick();
  assert.equal(installs, 1);
});
