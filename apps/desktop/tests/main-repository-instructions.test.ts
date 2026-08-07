import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const repositoryInstructionsPath = new URL("../src/main/repositoryInstructions.ts", import.meta.url);

// Only the workspace root's AGENTS.md is injected. A monorepo carries one per
// package, and shipping all of them spends the model's context on directories
// the task never touches while burying the file that governs everything. The
// nested files still apply — the model reads the nearest one when it works
// there, which is a targeted read instead of a tax on every turn.
test("only the workspace root AGENTS.md is injected, never nested ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-agent-instructions-"));
  const deepDirectory = path.join(root, "a", "b", "c");
  fs.mkdirSync(deepDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules");
  fs.writeFileSync(path.join(deepDirectory, "AGENTS.md"), "deep rules");
  for (let index = 0; index < 13; index += 1) {
    const directory = path.join(root, `package-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "AGENTS.md"), `package ${index}`);
  }

  const { rootAgentInstructions } = loadTypeScriptModule(repositoryInstructionsPath);
  const instructions = rootAgentInstructions(root, {
    readTextFile: (filePath: string) => fs.readFileSync(filePath, "utf8"),
  });

  assert.equal(instructions?.path, "AGENTS.md");
  assert.equal(instructions?.text, "root rules");
});

test("a workspace with no root AGENTS.md contributes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-agent-instructions-"));
  // A nested file must not be promoted in the root's absence: that would inject
  // rules for one package as though they governed the whole workspace.
  const nested = path.join(root, "packages", "runner");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "AGENTS.md"), "runner rules");

  const { rootAgentInstructions } = loadTypeScriptModule(repositoryInstructionsPath);
  assert.equal(
    rootAgentInstructions(root, { readTextFile: (filePath: string) => fs.readFileSync(filePath, "utf8") }),
    null,
  );
});

test("an unreadable root file is skipped rather than injected empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-agent-instructions-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "binary-ish");

  const { rootAgentInstructions } = loadTypeScriptModule(repositoryInstructionsPath);
  assert.equal(rootAgentInstructions(root, { readTextFile: () => null }), null);
});
