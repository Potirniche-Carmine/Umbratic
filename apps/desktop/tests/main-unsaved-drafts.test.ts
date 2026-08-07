import assert from "node:assert";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const draftsPath = new URL("../src/main/unsavedDrafts.ts", import.meta.url);

test("an unsaved chat draft survives switching workspaces and is scoped to one", () => {
  const { readUnsavedDraft, writeUnsavedDraft } = loadTypeScriptModule(draftsPath);

  assert.deepEqual(readUnsavedDraft({ scope: "/a" }), { draftPrompt: "", attachedFiles: [] });

  writeUnsavedDraft({ scope: "/a", draftPrompt: "half a thought", attachedFiles: [] });
  writeUnsavedDraft({ scope: "/b", draftPrompt: "a different thought", attachedFiles: [] });

  // The point of the feature: leaving and coming back does not lose the text.
  assert.equal(readUnsavedDraft({ scope: "/a" }).draftPrompt, "half a thought");
  assert.equal(readUnsavedDraft({ scope: "/b" }).draftPrompt, "a different thought");
  // A workspace nobody typed into has no draft.
  assert.equal(readUnsavedDraft({ scope: "/c" }).draftPrompt, "");
});

test("clearing an unsaved draft removes it rather than storing an empty one", () => {
  const { clearUnsavedDraft, readUnsavedDraft, writeUnsavedDraft } = loadTypeScriptModule(draftsPath);

  writeUnsavedDraft({ scope: "", draftPrompt: "typed then deleted", attachedFiles: [] });
  writeUnsavedDraft({ scope: "", draftPrompt: "", attachedFiles: [] });
  assert.equal(readUnsavedDraft({ scope: "" }).draftPrompt, "");

  writeUnsavedDraft({ scope: "/project", draftPrompt: "became a real chat", attachedFiles: [] });
  clearUnsavedDraft({ scope: "/project" });
  assert.equal(readUnsavedDraft({ scope: "/project" }).draftPrompt, "");
});

test("unsaved drafts are bounded so the map cannot grow without limit", () => {
  const { readUnsavedDraft, writeUnsavedDraft } = loadTypeScriptModule(draftsPath);

  for (let index = 0; index < 200; index += 1) {
    writeUnsavedDraft({ scope: `/scope-${index}`, draftPrompt: `draft ${index}`, attachedFiles: [] });
  }
  // The most recent writes are kept and the oldest scopes were evicted.
  assert.equal(readUnsavedDraft({ scope: "/scope-199" }).draftPrompt, "draft 199");
  assert.equal(readUnsavedDraft({ scope: "/scope-0" }).draftPrompt, "");
});

test("a malformed draft request cannot throw or store junk", () => {
  const { readUnsavedDraft, writeUnsavedDraft } = loadTypeScriptModule(draftsPath);

  assert.deepEqual(readUnsavedDraft(null), { draftPrompt: "", attachedFiles: [] });
  assert.deepEqual(writeUnsavedDraft(undefined), { draftPrompt: "", attachedFiles: [] });
  writeUnsavedDraft({ scope: 7, draftPrompt: 42, attachedFiles: "not an array" });
  assert.deepEqual(readUnsavedDraft({ scope: "" }), { draftPrompt: "", attachedFiles: [] });
});
