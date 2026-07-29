import assert from "node:assert/strict";
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
    pathsModule.electronLogsDirectory(root),
    pathsModule.crashDumpsDirectory(root),
    pathsModule.runnerLogsDirectory(root),
    pathsModule.telemetrySpoolDirectoryPath(root),
  ];
  assert.equal(paths.every((value) => path.relative(root, value) && !path.relative(root, value).startsWith("..")), true);
});
