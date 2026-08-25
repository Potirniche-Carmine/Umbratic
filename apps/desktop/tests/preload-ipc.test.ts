import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

test("preload exposes every desktop API method on the expected IPC channel", async () => {
  const invocations = [];
  const listeners = new Map();
  let exposedName = "";
  let exposedApi = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposedName = name;
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke(channel, input) {
        invocations.push({ channel, input });
        return Promise.resolve({ channel, input });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  };

  const { desktopIpcChannels } = loadTypeScriptModule(
    new URL("../src/shared/desktopApi.ts", import.meta.url),
  );
  loadTypeScriptModule(new URL("../src/preload/preload.ts", import.meta.url), { mocks: { electron } });
  assert.equal(exposedName, "umbratic");

  const listenerMethods = [
    "onBackendEvent",
    "onWorkspaceIndex",
    "onDictationEvent",
    "onModelDownloadEvent",
    "onAppUpdateStatus",
  ];
  const invokeMethods = Object.keys(exposedApi)
    .filter((method) => !listenerMethods.includes(method))
    .sort();
  assert.deepEqual(invokeMethods, Object.keys(desktopIpcChannels).sort());

  const probe = { probe: true };
  for (const method of invokeMethods) {
    invocations.length = 0;
    const fn = exposedApi[method];
    await (fn.length === 0 ? fn() : fn(probe));
    assert.equal(invocations.length, 1, method);
    assert.equal(invocations[0].channel, desktopIpcChannels[method], method);
    if (fn.length === 0) {
      assert.equal(invocations[0].input, undefined, method);
    } else {
      assert.deepEqual(plain(invocations[0].input), plain(probe), method);
    }
  }

  const received = [];
  const unsubscribe = exposedApi.onBackendEvent((event) => received.push(event));
  assert.equal(listeners.has("umbratic:backend-event"), true);
  // The preload is a delivery bridge, not a third validator. Runner events are
  // decoded at the runner boundary and everything else is constructed in the
  // main process against BackendUiEvent, so what arrives here is already settled
  // and is handed to the renderer as-is.
  listeners.get("umbratic:backend-event")({}, { type: "assistant.done", taskId: "task-1" });
  listeners.get("umbratic:backend-event")({}, { type: "assistant.delta", taskId: "task-1", text: "hi" });
  assert.deepEqual(plain(received), [
    { type: "assistant.done", taskId: "task-1" },
    { type: "assistant.delta", taskId: "task-1", text: "hi" },
  ]);
  unsubscribe();
  assert.equal(listeners.has("umbratic:backend-event"), false);

  const downloadEvents = [];
  const stopDownloads = exposedApi.onModelDownloadEvent((event) => downloadEvents.push(event));
  assert.equal(listeners.has("umbratic:model-download"), true);
  listeners.get("umbratic:model-download")({}, { id: "gemma4-e2b", receivedBytes: 1, totalBytes: 2, state: "downloading" });
  assert.deepEqual(plain(downloadEvents), [{ id: "gemma4-e2b", receivedBytes: 1, totalBytes: 2, state: "downloading" }]);
  stopDownloads();
  assert.equal(listeners.has("umbratic:model-download"), false);

  const updateStatuses = [];
  const stopUpdates = exposedApi.onAppUpdateStatus((status) => updateStatuses.push(status));
  assert.equal(listeners.has("umbratic:app-update-status"), true);
  listeners.get("umbratic:app-update-status")({}, { installedVersion: "0.0.3", automatic: true, checkedAt: null, state: { phase: "current" } });
  assert.deepEqual(plain(updateStatuses), [{ installedVersion: "0.0.3", automatic: true, checkedAt: null, state: { phase: "current" } }]);
  stopUpdates();
  assert.equal(listeners.has("umbratic:app-update-status"), false);

  const dictationEvents = [];
  const stopDictation = exposedApi.onDictationEvent((event) => dictationEvents.push(event));
  assert.equal(listeners.has("umbratic:dictation-event"), true);
  listeners.get("umbratic:dictation-event")({}, { state: "listening" });
  assert.deepEqual(plain(dictationEvents), [{ state: "listening" }]);
  stopDictation();
  assert.equal(listeners.has("umbratic:dictation-event"), false);

  const indexEvents = [];
  const stopIndex = exposedApi.onWorkspaceIndex((event) => indexEvents.push(event));
  assert.equal(listeners.has("umbratic:workspace-index"), true);
  listeners.get("umbratic:workspace-index")({}, { state: "ready" });
  assert.deepEqual(plain(indexEvents), [{ state: "ready" }]);
  stopIndex();
  assert.equal(listeners.has("umbratic:workspace-index"), false);
});

test("a failed call reports the message the main process wrote, not Electron's wrapper", async () => {
  let exposedApi = null;
  let rejection = new Error("unset");
  const electron = {
    contextBridge: { exposeInMainWorld(_name, api) { exposedApi = api; } },
    ipcRenderer: {
      invoke: () => Promise.reject(rejection),
      on() {},
      removeListener() {},
    },
  };
  loadTypeScriptModule(new URL("../src/preload/preload.ts", import.meta.url), { mocks: { electron } });

  const failureMessage = async () => {
    try {
      await exposedApi.saveRemoteConnection({});
      return "";
    } catch (cause) {
      return cause.message;
    }
  };

  // What Electron actually rejects with: the channel name and the thrown
  // class wrapped around the one sentence written for a person to read.
  rejection = new Error("Error invoking remote method 'umbratic:save-remote-connection': Error: Enter the remote host.");
  assert.equal(await failureMessage(), "Enter the remote host.");

  rejection = new Error("Error invoking remote method 'umbratic:check-remote-connection': SshError: The remote host name could not be resolved.");
  assert.equal(await failureMessage(), "The remote host name could not be resolved.");

  // A message that was never wrapped is left exactly as it is.
  rejection = new Error("The remote request was cancelled.");
  assert.equal(await failureMessage(), "The remote request was cancelled.");

  // Nothing readable is still worth saying something readable about.
  rejection = new Error("Error invoking remote method 'umbratic:get-task': Error: ");
  assert.match(await failureMessage(), /did not work/);
});

test("compiled sandboxed preload has no relative runtime dependencies", () => {
  const source = fs.readFileSync(new URL("../dist-electron/preload/preload.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /require\(["']\.\.?\//);
});
