import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
const usage = loadTypeScriptModule(new URL("../src/main/cloudUsage.ts", import.meta.url), { realm: "host" });
const cloud = loadTypeScriptModule(new URL("../src/shared/cloud.ts", import.meta.url), { realm: "host" });
test("provider quota percentages retain their units and omit unavailable windows", () => {
  const codex = usage.codexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null } });
  assert.equal(codex.limits.length, 1); assert.equal(codex.limits[0].usedPercent, 34); assert.equal(codex.limits[0].label, "5 hours");
  assert.equal(codex.limits[0].resetsAt, new Date(1800000000000).toISOString());
  const claude = usage.claudeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0.8, resets_at: null }, seven_day: { utilization: null } } });
  assert.equal(claude.limits.length, 1); assert.equal(claude.limits[0].usedPercent, 0.8);
  assert.deepEqual(usage.claudeUsage({ rate_limits_available: false }).limits, []);
  assert.deepEqual(usage.codexUsage({}).limits, []);
});
test("old compaction-count resets are discarded while inactivity remains configurable", () => {
  const settings = cloud.validateCloudSettings({ ...cloud.defaultCloudSettings(), resetAfterCompactions: 5, contextPolicyVersion: 2 });
  assert.equal(Object.hasOwn(settings, "resetAfterCompactions"), false);
  assert.equal(Object.hasOwn(settings, "contextPolicyVersion"), false);
  assert.equal(settings.idleResetHours, 3);
  assert.equal(cloud.contextResetReason({ sessionId: "native", state: "idle", compactions: 99, entries: [], lastActiveAt: new Date().toISOString() }, settings), undefined);
});
