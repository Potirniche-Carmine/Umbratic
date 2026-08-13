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
  assert.match(implementation, /return mode/);
  assert.doesNotMatch(implementation, /getBackendStatus/);
});

test("the top connection refresh owns local model discovery", () => {
  const connection = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  const picker = fs.readFileSync(new URL("../src/renderer/Combobox.tsx", import.meta.url), "utf8");
  const start = connection.indexOf("async function refresh()");
  const end = connection.indexOf("\n  async function save()", start);
  const refresh = connection.slice(start, end);
  assert.match(refresh, /api\.probeLocalModels/);
  assert.match(refresh, /modelsBeforeRefresh/);
  assert.doesNotMatch(refresh, /setTimeout/);
  assert.doesNotMatch(picker, /probeLocalModels|RefreshCw|setTimeout/);
  assert.match(picker, /const interactionDisabled = disabled \|\| options\.length === 0/);
});

test("local model and context choices commit before backend reload completes", () => {
  const connection = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  const connectionSave = connection.slice(
    connection.indexOf("async function save()"),
    connection.indexOf("\n  async function disconnect()", connection.indexOf("async function save()")),
  );
  assert.ok(connectionSave.indexOf("setSettings(optimisticLocalSettings)") < connectionSave.indexOf("await api.saveModelEndpointSettings"));

  const main = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  const harnessSave = main.slice(
    main.indexOf("async function saveHarnessProfile()"),
    main.indexOf("\n  async function loadSkills()", main.indexOf("async function saveHarnessProfile()")),
  );
  assert.ok(harnessSave.indexOf("setContextLength(optimisticContextLength)") < harnessSave.indexOf("await api.saveContextLength"));
});

test("the default composer uses the compact 76 pixel shell", () => {
  const source = fs.readFileSync(new URL("../src/renderer/styles/composer.css", import.meta.url), "utf8");
  const start = source.indexOf(".promptInputShell");
  const end = source.indexOf("\n}", start);
  const shell = source.slice(start, end);
  // Attachments, editor, rail. The attachment track is `auto`, so with nothing
  // picked it is zero-height and the default shell is still the compact one —
  // the box grows upward only once there is a chip to hold.
  assert.match(shell, /grid-template-rows: auto minmax\(38px, auto\) 38px/);
  assert.match(shell, /min-height: 76px/);
});

test("active task updates preserve the chat connection marker", () => {
  const source = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function upsertChatFromTask");
  const end = source.indexOf("\n  async function loadChats", start);
  assert.match(
    source.slice(start, end),
    /modelEndpointMode: existing\?\.modelEndpointMode \?\? endpointSettings\.mode/,
  );
});

test("an enrolled company server can reconnect or unregister with confirmation", () => {
  const source = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  const actions = fs.readFileSync(new URL("../src/renderer/CompanyServerActions.tsx", import.meta.url), "utf8");
  assert.match(source, /const companyServerConnected =/);
  assert.match(source, /const companyServerActive =/);
  assert.match(source, /companyServerConnected && companyConnection\.state === "enrolled" \? \(/);
  assert.match(source, /<CompanyServerActions/);
  assert.match(actions, /active \? "Disconnect" : "Connect"/);
  assert.match(actions, /onClick=\{active \? onDisconnect : onConnect\}/);
  assert.doesNotMatch(actions, /!active \? \(/);
  assert.match(source, /backend\?\.endpoint === "ready"/);
  assert.match(source, /api\.connectCompanyConnection\(\)/);
  assert.match(source, /api\.disconnectCompanySession\(\)/);
  assert.match(actions, /Unregister this device\?/);
  assert.match(actions, /ask your administrator for a new enrollment key/);
  // Local mode applies a model on selection, so the save step is server-only.
  assert.match(source, /\{!companyServerConnected && draft\.mode === "server" \? \(/);
  assert.match(source, /async function selectLocalModel/);
});

test("connection state and UI are outside the main renderer shell", () => {
  const main = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  const connection = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  assert.match(main, /useConnectionSettings\(/);
  assert.match(main, /<ConnectionSettingsPanel controller=\{connectionSettings\} \/>/);
  assert.doesNotMatch(main, /async function saveEndpointSettings/);
  assert.match(connection, /export function useConnectionSettings/);
});

test("local mode discovers models automatically and applies a choice without a save step", () => {
  const source = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  // Opening the panel probes the runtime; the old flow only read a cache and
  // waited for a manual refresh, which is how a run could start with no model.
  assert.match(source, /api\s*\n?\s*\.probeLocalModels\(\{ baseUrl \}\)/);
  assert.match(source, /setLocalModelDiscovery\(\{ baseUrl, models, status: probe\.status \}\)/);
  // Choosing a model persists it directly.
  assert.match(source, /onSelect=\{\(modelId\) => void controller\.selectLocalModel\(modelId\)\}/);
  assert.match(source, /await api\.saveModelEndpointSettings\(next\)/);
  // The runtime URL is no longer the first thing a user meets.
  assert.match(source, /<details className="settingsAdvanced">/);
});

test("startup warm-up treats an unchosen local model as ordinary first-run state", () => {
  const warmup = fs.readFileSync(new URL("../src/main/modelWarmup.ts", import.meta.url), "utf8");
  assert.match(warmup, /if \(!settings\.modelId\.trim\(\)\) return;/);
});
