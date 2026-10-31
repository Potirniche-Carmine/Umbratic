import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const pathsModule = loadTypeScriptModule(
  new URL("../src/main/appPaths.ts", import.meta.url),
  { cache: new Map() },
);

test("desktop data roots follow each operating system data convention", () => {
  assert.equal(
    pathsModule.defaultDesktopDataRoot("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test"),
    path.join("C:\\Users\\test\\AppData\\Local", "Umbratic"),
  );
  assert.equal(
    pathsModule.defaultDesktopDataRoot("darwin", {}, "/Users/test"),
    path.join("/Users/test", "Library", "Application Support", "Umbratic"),
  );
  assert.equal(
    pathsModule.defaultDesktopDataRoot("linux", { XDG_DATA_HOME: "/home/test/.data" }, "/home/test"),
    path.join("/home/test/.data", "Umbratic"),
  );
});

test("all managed desktop paths stay below one data root", () => {
  const root = path.resolve("C:\\data\\Umbratic");
  const paths = [
    pathsModule.appDatabaseFile(root),
    pathsModule.chatsDatabaseFile(root),
    pathsModule.taskMetadataDirectory(root),
    pathsModule.chatAttachmentsDirectory(root),
    pathsModule.skillsDirectory(root),
    pathsModule.scratchWorkspacesDirectory(root),
    pathsModule.worktreesDirectory(root),
    pathsModule.runtimesDirectory(root),
    pathsModule.workspaceRuntimeDirectory(root, "C:\\repo"),
    pathsModule.workspaceOcrDirectory(root, "C:\\repo"),
    pathsModule.electronSessionDirectory(root),
    pathsModule.temporaryDirectory(root),
    pathsModule.electronLogsDirectory(root),
    pathsModule.crashDumpsDirectory(root),
    pathsModule.runnerLogsDirectory(root),
  ];
  assert.equal(paths.every((value) => path.relative(root, value) && !path.relative(root, value).startsWith("..")), true);
});

test("Electron and child processes share an owner-only temporary directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = new Map<string, string>();
  const environment: NodeJS.ProcessEnv = { TMPDIR: "/unusable-system-temp" };
  pathsModule.configureDesktopAppPaths({
    setPath: (name: string, value: string) => configured.set(name, value),
    setAppLogsPath: (value: string) => configured.set("logs", value),
  }, root, environment);
  const temporary = path.join(root, "cache", "tmp");
  assert.equal(configured.get("temp"), temporary);
  assert.equal(environment.TMPDIR, temporary);
  assert.equal(environment.TMP, temporary);
  assert.equal(environment.TEMP, temporary);
  fs.writeFileSync(path.join(temporary, "probe"), "writable");
  if (process.platform !== "win32") assert.equal(fs.statSync(temporary).mode & 0o777, 0o700);
  assert.equal(configured.get("userData"), root);
});
