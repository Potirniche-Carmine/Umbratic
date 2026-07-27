import assert from "node:assert/strict";
import test from "node:test";

import { desktopIpcChannels } from "../src/shared/desktopApi.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("IPC registry registers every shared channel and blocks untrusted senders", async () => {
  const registered = new Map<string, (event: unknown, input: unknown) => unknown>();
  const errors: unknown[] = [];
  const electron = {
    ipcMain: {
      handle(channel: string, handler: (event: unknown, input: unknown) => unknown) {
        registered.set(channel, handler);
      },
    },
  };
  const { registerDesktopIpcHandlers } = loadTypeScriptModule(
    new URL("../src/main/ipcRegistry.ts", import.meta.url),
    { mocks: { electron } },
  );
  const handlers = Object.fromEntries(
    Object.keys(desktopIpcChannels).map((method) => [
      method,
      (input: unknown) => ({ method, input }),
    ]),
  );

  registerDesktopIpcHandlers(handlers, {
    trustedSender: (event: { trusted?: boolean }) => event.trusted === true,
    onError: (error: unknown) => errors.push(error),
  });

  assert.deepEqual(
    [...registered.keys()].sort(),
    Object.values(desktopIpcChannels).sort(),
  );
  const listProjects = registered.get(desktopIpcChannels.listProjects);
  assert.deepEqual(
    await listProjects({ trusted: true }, { query: "x" }),
    { method: "listProjects", input: { query: "x" } },
  );
  await assert.rejects(
    () => listProjects({ trusted: false }, undefined),
    /untrusted renderer/,
  );
  assert.equal(errors.length, 1);
});
