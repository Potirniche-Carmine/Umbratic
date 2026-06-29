import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

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

  loadTypeScriptModule(new URL("../src/preload/preload.ts", import.meta.url), { mocks: { electron } });
  assert.equal(exposedName, "umbratic");

  const cases = [
    ["listChats", [], "umbratic:list-chats", undefined],
    ["createChat", [], "umbratic:create-chat", {}],
    ["updateChatDraft", [{ chatId: "chat-1", draftPrompt: "hi", attachedFiles: [] }], "umbratic:update-chat-draft"],
    ["deleteChat", [{ chatId: "chat-1" }], "umbratic:delete-chat"],
    ["getNotes", [], "umbratic:get-notes", undefined],
    ["updateNotes", [{ content: "notes" }], "umbratic:update-notes"],
    ["getTask", [{ taskId: "task-1" }], "umbratic:get-task"],
    ["refreshTaskReview", [{ taskId: "task-1" }], "umbratic:refresh-task-review"],
    ["searchFiles", [{ repositoryId: "repo", query: "app" }], "umbratic:search-files"],
    ["pickRepository", [], "umbratic:pick-repository", undefined],
    ["pickAttachmentFiles", [{ chatId: "chat-1" }], "umbratic:pick-attachment-files"],
    ["savePastedAttachments", [{ chatId: "chat-1", files: [] }], "umbratic:save-pasted-attachments"],
    ["openChatAttachment", [{ attachment: { path: "a", name: "a" } }], "umbratic:open-chat-attachment"],
    ["getRepository", [{ repositoryId: "repo" }], "umbratic:get-repository"],
    ["listRepositoryBranches", [{ repositoryId: "repo" }], "umbratic:list-repository-branches"],
    ["checkoutRepositoryBranch", [{ repositoryId: "repo", branch: "main" }], "umbratic:checkout-repository-branch"],
    ["getBackendStatus", [], "umbratic:get-backend-status", undefined],
    ["getCapabilityProbes", [{ force: true }], "umbratic:get-capability-probes"],
    ["getHarnessProfile", [], "umbratic:get-harness-profile", undefined],
    ["saveHarnessProfile", ["marketing"], "umbratic:save-harness-profile"],
    ["getModelEndpointSettings", [], "umbratic:get-model-endpoint-settings", undefined],
    ["saveModelEndpointSettings", [{ mode: "local", software: "ollama", baseUrl: "http://127.0.0.1:8080", modelId: "veil-managed", secret: "", headers: [] }], "umbratic:save-model-endpoint-settings"],
    ["exportTelemetry", [], "umbratic:export-telemetry", undefined],
    ["listSkills", [], "umbratic:list-skills", undefined],
    ["saveSkillSettings", [{ skill: false }], "umbratic:save-skill-settings"],
    ["openSkillsFolder", [], "umbratic:open-skills-folder", undefined],
    ["openSkillInEditor", [{ id: "umbratic-marketing" }], "umbratic:open-skill-in-editor"],
    ["importSkill", [{ sourcePath: "/tmp/skill.zip" }], "umbratic:import-skill"],
    ["createSkill", [{ name: "Skill" }], "umbratic:create-skill"],
    ["getSkillDocument", [{ id: "skill" }], "umbratic:get-skill-document"],
    ["saveSkillDocument", [{ id: "skill", content: "# Skill" }], "umbratic:save-skill-document"],
    ["setPermissionMode", ["bypass"], "umbratic:set-permission-mode"],
    ["listAvailableIdes", [], "umbratic:list-available-ides", undefined],
    ["startTask", [{ prompt: "go" }], "umbratic:start-task"],
    ["approveWorktreeCreation", [{ taskId: "task-1", approved: true }], "umbratic:approve-worktree-creation"],
    ["respondToToolPermission", [{ taskId: "task-1", id: "perm", decision: "allow" }], "umbratic:respond-tool-permission"],
    ["openRepositoryInIde", [{ repositoryId: "repo", ideId: "vscode" }], "umbratic:open-repository-in-ide"],
    ["openTaskInIde", [{ taskId: "task-1", ideId: "vscode" }], "umbratic:open-task-in-ide"],
    ["approveTaskMerge", [{ taskId: "task-1" }], "umbratic:approve-task-merge"],
    ["rejectTask", [{ taskId: "task-1", cleanup: true }], "umbratic:reject-task"],
    ["keepWorktree", [{ taskId: "task-1" }], "umbratic:keep-worktree"],
    ["cancelTask", [{ taskId: "task-1" }], "umbratic:cancel-task"],
    ["setResponseFeedback", [{ taskId: "task-1", messageId: "m1", rating: "good" }], "umbratic:set-response-feedback"],
    ["setWindowChromeTheme", ["dark"], "umbratic:set-window-chrome-theme"],
  ];

  for (const [method, args, channel, explicitInput] of cases) {
    invocations.length = 0;
    await exposedApi[method](...args);
    assert.equal(invocations[0].channel, channel, method);
    const expectedInput = explicitInput !== undefined ? explicitInput : args[0];
    assert.deepEqual(plain(invocations[0].input), plain(expectedInput), method);
  }

  const received = [];
  const unsubscribe = exposedApi.onBackendEvent((event) => received.push(event));
  assert.equal(listeners.has("umbratic:backend-event"), true);
  listeners.get("umbratic:backend-event")({}, { type: "assistant.done", taskId: "task-1" });
  assert.deepEqual(plain(received), [{ type: "assistant.done", taskId: "task-1" }]);
  unsubscribe();
  assert.equal(listeners.has("umbratic:backend-event"), false);
});
