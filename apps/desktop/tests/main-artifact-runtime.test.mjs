import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const artifactRuntime = loadTypeScriptModule(new URL("../src/main/artifactRuntime.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("artifactKindsForPrompt selects concrete artifact types from realistic requests", () => {
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Create a board deck in PPTX.")), ["pptx"]);
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Build a PDF report and Excel workbook.")), ["pdf", "xlsx"]);
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Fix the login test.")), []);
  assert.equal(artifactRuntime.promptLooksLikeArtifactTask("Write a one-pager"), true);
  assert.equal(artifactRuntime.promptLooksLikeArtifactTask("Explain this function"), false);
  assert.equal(artifactRuntime.promptLooksLikeOcrTask("Extract text from this screenshot."), true);
  assert.equal(artifactRuntime.promptLooksLikeOcrTask("Refactor this parser."), false);
});
