import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const repositoryInstructionsPath = new URL("../src/main/repositoryInstructions.ts", import.meta.url);

test("repository instructions include every safe AGENTS.md in root-first order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-agent-instructions-"));
  const deepDirectory = path.join(root, "a", "b", "c", "d", "e");
  fs.mkdirSync(deepDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root\n" + "x".repeat(25_000));
  fs.writeFileSync(path.join(deepDirectory, "AGENTS.md"), "deep");
  for (let index = 0; index < 13; index += 1) {
    const directory = path.join(root, `package-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "AGENTS.md"), `package ${index}`);
  }
  const ignoredDirectory = path.join(root, "node_modules", "dependency");
  fs.mkdirSync(ignoredDirectory, { recursive: true });
  fs.writeFileSync(path.join(ignoredDirectory, "AGENTS.md"), "ignore me");

  const { findAgentInstructionFiles } = loadTypeScriptModule(repositoryInstructionsPath);
  const files = findAgentInstructionFiles(root, {
    readTextFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    shouldSkipDirectory: ({ name }) => name === "node_modules",
  });

  assert.equal(files[0].path, "AGENTS.md");
  assert.equal(files[0].text.length, 25_005);
  assert.equal(files.some((file) => file.path === "a/b/c/d/e/AGENTS.md" && file.text === "deep"), true);
  assert.equal(files.filter((file) => file.path.endsWith("AGENTS.md")).length, 15);
  assert.equal(files.some((file) => file.path.includes("node_modules")), false);
});
