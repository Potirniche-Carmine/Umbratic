import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

// Defer state updaters until the next render, as React is allowed to do.
// An API write must not depend on React eagerly executing a state updater.
function renderHook(api) {
  const slots = [];
  const updates = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => updates.push(() => { slots[index] = typeof value === "function" ? value(slots[index]) : value; })];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: (compute) => compute(),
    useEffect: () => {},
  };
  const { useSkillSettings } = loadTypeScriptModule(new URL("../src/renderer/useSkillSettings.ts", import.meta.url), { mocks: { react } });
  return () => {
    for (const update of updates.splice(0)) update();
    cursor = 0;
    return useSkillSettings(api);
  };
}

const initial = [{ id: "a", enabled: true, source: "local" }, { id: "b", enabled: true, source: "local" }];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("rapid skill toggles persist cumulative values and serialize whole-map writes", async () => {
  const calls = [];
  const responses = [];
  const render = renderHook({
    listSkills: async () => ({ skills: initial }),
    saveSkillSettings: (flags) => { calls.push({ ...flags }); return new Promise((resolve) => responses.push(() => resolve({ skills: initial.map((skill) => ({ ...skill, enabled: flags[skill.id] })) }))); },
  });
  await render().loadSkills();
  const controller = render();
  controller.panelProps.onToggleEnabled("a");
  controller.panelProps.onToggleEnabled("b");
  await tick();
  assert.deepEqual(calls, [{ a: false, b: true }]);
  assert.deepEqual({ ...render().skillsEnabled }, { a: false, b: false });
  responses.shift()();
  await tick();
  assert.deepEqual(calls, [{ a: false, b: true }, { a: false, b: false }]);
  responses.shift()();
  await tick();
  assert.deepEqual({ ...render().skillsEnabled }, { a: false, b: false });
});

test("failed queued skill writes roll back to the last confirmed settings", async () => {
  const render = renderHook({
    listSkills: async () => ({ skills: initial }),
    saveSkillSettings: async () => { throw new Error("storage unavailable"); },
  });
  await render().loadSkills();
  const controller = render();
  controller.panelProps.onToggleEnabled("a");
  controller.panelProps.onToggleEnabled("b");
  await tick();
  const restored = render();
  assert.deepEqual({ ...restored.skillsEnabled }, { a: true, b: true });
  assert.match(restored.panelProps.skillsMessage, /storage unavailable/);
});

test("changing the skill source discards an in-flight preview", async () => {
  let respond;
  const render = renderHook({
    listSkills: async () => ({ skills: initial }),
    getSkillDocument: () => new Promise((resolve) => { respond = resolve; }),
  });
  await render().loadSkills();
  render().panelProps.onTogglePreview("a");
  assert.equal(render().panelProps.skillPreviewLoading, true);
  render().panelProps.onSelectSourceFilter("system");
  respond({ ok: true, skill: { id: "a", name: "Old preview", content: "stale", enabled: true, source: "local" } });
  await tick();
  const changed = render().panelProps;
  assert.equal(changed.skillSourceFilter, "system");
  assert.equal(changed.selectedSkillId, null);
  assert.equal(changed.skillDocument, null);
  assert.equal(changed.skillPreviewLoading, false);
});
