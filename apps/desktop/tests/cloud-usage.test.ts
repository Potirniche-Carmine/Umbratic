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

test("Claude usage reports keep server model scopes, active meter and severity", () => {
  const value = usage.claudeUsage({ rate_limits: { limits: [
    { kind: "session", group: "session", percent: 28, resets_at: null, severity: "normal", is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 92, resets_at: null, scope: { model: { display_name: "Fable" } }, severity: "critical", is_active: true },
  ] } });
  assert.equal(value.limits[0].usedPercent, 28);
  assert.equal(value.limits[1].label, "Fable · weekly");
  assert.equal(value.limits[1].severity, "critical");
  assert.equal(value.limits[1].active, true);
  const control = usage.claudeUsage({ rate_limits_available: true, rate_limits: { model_scoped: [{ display_name: "Fable", utilization: 31, resets_at: null }] } });
  assert.equal(control.limits[0].usedPercent, 31);
});

test("temporary empty usage retains a recent reading but never an expired quota", () => {
  const { latestCloudUsage } = loadTypeScriptModule(new URL("../src/shared/cloudUsage.ts", import.meta.url), { realm: "host" });
  const now = Date.now();
  const good = { fetchedAt: new Date(now - 1000).toISOString(), limits: [{ id: "weekly", label: "Weekly", usedPercent: 38, resetsAt: new Date(now + 60_000).toISOString() }] };
  const empty = { fetchedAt: new Date(now).toISOString(), limits: [] };
  assert.deepEqual(latestCloudUsage([empty, good], now), good);
  assert.equal(latestCloudUsage([good], now + 60_001), undefined);
  assert.equal(latestCloudUsage([{ ...good, fetchedAt: new Date(now - 16 * 60_000).toISOString() }], now), undefined);
});

test("native activity labels do not masquerade as executed shell commands", () => {
  const display = loadTypeScriptModule(new URL("../src/renderer/commandDisplay.ts", import.meta.url), { realm: "host" });
  const run = { id: "tool", command: "cat brief.txt", nativeDisplay: { label: "Read project notes", detail: "cat brief.txt\n\nProject notes" }, cwd: "/workspace", stdout: "", stderr: "", exitCode: null, status: "passed" };
  assert.equal(display.activityToolLabel(run).label, "Read project notes");
  assert.equal(display.commandShellText(run), "cat brief.txt\n\nProject notes");
  assert.equal(display.commandLiveOutputPreview({ ...run, status: "running" }), undefined);
});

test("an empty per-model map does not hide the primary account windows", () => {
  const result = usage.codexUsage({ rateLimitsByLimitId: {}, rateLimits: { primary: { usedPercent: 22, windowDurationMins: 300 }, secondary: { usedPercent: 45, windowDurationMins: 10080 } } });
  assert.deepEqual(result.limits.map(limit => limit.label), ["5 hours", "Weekly"]);
});

test("quota labels and accessible meters use the provider's used percentage", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { loadRendererFile } = await import("./helpers/load-renderer.ts");
  const { CloudUsageDetails, CloudUsageIndicator } = loadRendererFile("cloud/CloudUsage.tsx");
  const reading = { fetchedAt: new Date().toISOString(), limits: [{ id: "weekly", label: "Weekly", usedPercent: 54 }] };
  const detail = renderToStaticMarkup(React.createElement(CloudUsageDetails, { usage: reading }));
  assert.match(detail, /54% used/); assert.match(detail, /aria-valuenow="54"/); assert.doesNotMatch(detail, /46%/);
  const compact = renderToStaticMarkup(React.createElement(CloudUsageIndicator, { usage: reading, workspace: { contextWindow: 100_000, inputTokens: 3_000 } }));
  assert.match(compact, /54%<small>Weekly/); assert.match(compact, /3%<small>Context/); assert.doesNotMatch(compact, /Usage left/);
  assert.match(compact, /54% of the usage limit used, 3% context used/);
});
