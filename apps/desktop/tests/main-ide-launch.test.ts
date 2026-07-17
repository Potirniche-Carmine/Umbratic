import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { codeLikeIdeArgs, macCodeLikeIdeArgs } = loadTypeScriptModule(
  new URL("../src/main/ideLaunch.ts", import.meta.url),
);

test("VS Code folder launches reuse one window instead of forcing a duplicate", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(codeLikeIdeArgs("C:/repo", "folder"))),
    ["--reuse-window", "C:/repo"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(macCodeLikeIdeArgs("/repo", "folder"))),
    ["-a", "Visual Studio Code", "--args", "--reuse-window", "/repo"],
  );
});

test("VS Code file launches keep using the workspace and goto target", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(codeLikeIdeArgs("C:/repo/src/app.ts", "file", "C:/repo"))),
    ["--reuse-window", "C:/repo", "--goto", "C:/repo/src/app.ts"],
  );
});


