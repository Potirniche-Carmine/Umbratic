import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const config = loadTypeScriptModule(new URL("../src/main/config.ts", import.meta.url));

test("workspace prompt guidance treats file previews as partial and verifies structure questions", () => {
  const previewGuidance = config.workspaceContextVerificationPrompt.toLowerCase();
  assert.match(previewGuidance, /bounded preview/);
  assert.match(previewGuidance, /not a complete filesystem inventory/);
  for (const term of ["all", "existing", "current", "accurate", "folders", "subfolders", "project structure"]) {
    assert.match(previewGuidance, new RegExp(term));
  }
  assert.match(previewGuidance, /read tool/);
  assert.match(previewGuidance, /search tool/);

  const toolchainPrompt = config.workspaceToolchainSystemPrompt.toLowerCase();
  assert.match(toolchainPrompt, /directory inventories/);
  assert.match(toolchainPrompt, /do not treat provided workspace file previews as exhaustive/);
});
