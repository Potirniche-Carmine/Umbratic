import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("renderer loads SQLite startup settings before its first app render", () => {
  const source = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<PermissionMode>\(startupSettings\.permissionMode\)/);
  assert.match(source, /void api\.getStartupSettings\(\)\.then\(renderApp/);
  assert.match(source, /render\(<App startupSettings=\{startupSettings\} \/>/);
  assert.doesNotMatch(source, /useState<PermissionMode>\("normal"\)/);
});

test("changing Auto-run does not wait for model status", () => {
  const source = fs.readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function setPermissionMode");
  const end = source.indexOf("\n}", start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /return permissionMode/);
  assert.doesNotMatch(implementation, /getBackendStatus/);
});

test("the top connection refresh owns local model discovery", () => {
  const renderer = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  const picker = fs.readFileSync(new URL("../src/renderer/LocalModelPicker.tsx", import.meta.url), "utf8");
  const start = renderer.indexOf("async function refreshConnectionStatus");
  const end = renderer.indexOf("\n  async function saveEndpointSettings", start);
  assert.match(renderer.slice(start, end), /api\.probeLocalModels/);
  assert.doesNotMatch(picker, /probeLocalModels|RefreshCw|setTimeout/);
});
