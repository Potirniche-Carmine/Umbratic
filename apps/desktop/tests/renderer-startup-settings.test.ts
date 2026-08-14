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

test("the top connection refresh re-reads the local model list", () => {
  const connection = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  const picker = fs.readFileSync(new URL("../src/renderer/Combobox.tsx", import.meta.url), "utf8");
  const start = connection.indexOf("async function refresh()");
  const end = connection.indexOf("\n  async function save()", start);
  const refresh = connection.slice(start, end);
  assert.match(refresh, /await localCatalog\.reload\(\)/);
  assert.doesNotMatch(refresh, /setTimeout/);
  assert.doesNotMatch(picker, /RefreshCw|setTimeout/);
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

test("the default composer uses the compact 66 pixel shell", () => {
  const source = fs.readFileSync(new URL("../src/renderer/styles/composer.css", import.meta.url), "utf8");
  const start = source.indexOf(".promptInputShell");
  const end = source.indexOf("\n}", start);
  const shell = source.slice(start, end);
  // Attachments, editor, rail. The attachment track is `auto`, so with nothing
  // picked it is zero-height and the default shell is still the compact one —
  // the box grows upward only once there is a chip to hold.
  assert.match(shell, /grid-template-rows: auto minmax\(34px, auto\) 34px/);
  assert.match(shell, /min-height: 66px/);
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

test("local mode offers the catalog and applies a choice without a save step", () => {
  const source = fs.readFileSync(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), "utf8");
  const list = fs.readFileSync(new URL("../src/renderer/LocalModelList.tsx", import.meta.url), "utf8");
  // Opening the panel lists the catalog against what is on disk.
  assert.match(source, /useLocalModelCatalog\(api, "chat", settingsOpen && active\)/);
  assert.match(list, /api\.listLocalModels\(\{ kind \}\)/);
  // Choosing a downloaded model persists it directly.
  assert.match(source, /onSelect=\{\(modelId\) => void controller\.selectLocalModel\(modelId\)\}/);
  assert.match(source, /await api\.saveModelEndpointSettings\(next\)/);
  // There is no runtime URL to enter any more: the app starts its own.
  assert.doesNotMatch(source, /Ollama|11434|settingsAdvanced/);
});

test("startup never loads a model; the hardware probe is what warms", () => {
  const main = fs.readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  // Loading gigabytes of weights is an explicit user action — picking a model,
  // pressing load, or sending a prompt — never a side effect of opening the app.
  assert.doesNotMatch(main, /loadWindowWithModelWarmup|warmConfiguredModel/);
  assert.match(main, /void systemProfile\(\);/);
  const backend = fs.readFileSync(new URL("../src/main/backendSettings.ts", import.meta.url), "utf8");
  // Status reads stay passive; the explicit paths opt in.
  assert.match(backend, /getBackendStatus\(startLocal: LocalRuntimeStart = "never"\)/);
  assert.match(backend, /export async function loadLocalModel\(\)/);
});
