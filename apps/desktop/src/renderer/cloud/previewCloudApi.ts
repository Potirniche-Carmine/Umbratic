import { previewCloudConversation } from "./previewCloudConversation";
import { previewCodexModels } from "./previewCodexModels";
import { defaultCloudSettings, type CloudApi, type CloudConnection, type CloudProvider, type CloudWorkspace, type CloudImage } from "../../shared/cloud";

/** Browser-only design fixtures. Never installs, starts, or authenticates a runtime. */
export function createPreviewCloudApi(): CloudApi {
  let settings = defaultCloudSettings();
  const defaults = defaultCloudSettings();
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "cloud") settings.mode = "cloud";
  if (params.get("provider") === "claude") settings.provider = "claude";
  const initial = params.get("connection");
  const conversationFixture = params.get("cloudTest") === "conversation";
  const sourceFixture = params.get("cloudTest") === "source";
  if (sourceFixture) settings.workspaceRepositoryIds = ["preview-source"];
  const sourceText = ["#include <stdio.h>", "#include <stdbool.h>", "", "typedef struct {", "    unsigned int interval;", "    bool connected;", "} Monitor;", "", "/* Synchronize the selected monitor with its configured destinations. */", "int synchronize_monitor(Monitor *monitor)", "{", "    if (monitor == NULL) {", "        return -1;", "    }", "", "    if (!monitor->connected) {", "        fprintf(stderr, \"Waiting for connection\\n\");", "        return 0;", "    }", "", "    // Publish the latest status before starting another cycle.", "    printf(\"Synchronizing every %u seconds\\n\", monitor->interval);", "    return 1;", "}", ""].join("\n");
  const state: Record<CloudProvider, CloudConnection["state"]> = {
    codex: initial === "missing" || initial === "sign_in" ? initial : "ready",
    claude: initial === "missing" || initial === "sign_in" ? initial : "ready",
  };
  function connection(provider: CloudProvider): CloudConnection {
    return { ...(conversationFixture ? { planName: provider === "claude" ? "Team" : "Pro", usage: { fetchedAt: new Date().toISOString(), limits: [
      { id: "five_hour", label: "5 hours", usedPercent: 18, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
      { id: "weekly", label: "Weekly", usedPercent: 54, resetsAt: new Date(Date.now() + 24 * 3600_000).toISOString() },
    ] } } : {}), provider, state: state[provider], message: "Preview", account: state[provider] === "ready" ? "Preview account" : undefined,
      models: state[provider] !== "ready" ? [] : provider === "codex" ? previewCodexModels : [...new Set(Object.values(defaults.providers[provider].roles).map(choice => choice.model))].map(id => ({
        id, label: id === "gpt-6.1-sol" ? "GPT-6.1 Sol" : id === "gpt-6.1-terra" ? "GPT-6.1 Terra" : id === "claude-opus-5-5" ? "Opus 5.5" : "Sonnet 5.5",
        efforts: ["low", "medium", "high", "xhigh"],
      })),
    };
  }
  const chats = new Map<string, CloudWorkspace>();
  const images = new Map<string, CloudImage>();
  const emptyChat = (provider: CloudProvider, key = `preview-${provider}`): CloudWorkspace => ({ key, chatId: key, provider, path: "/preview", state: "idle", compactions: 0, entries: [], approvals: [] });
  return {
    listCloudChats: async ({ provider }) => [...chats.values()].filter(chat => chat.provider === provider).map(chat => ({ key: chat.key, provider, title: chat.entries[0]?.text || "New chat", paths: [chat.path], state: chat.state, updatedAt: chat.lastActiveAt || "" })),
    createCloudChat: async ({ provider }) => { const chat = emptyChat(provider, crypto.randomUUID()); chats.set(chat.key, chat); return chat; },
    deleteCloudChat: async ({ key }) => { chats.delete(key); },
    readCloudFile: async ({ path }) => { if (sourceFixture && ["/preview/core/monitor.c", "/preview/main.c"].includes(path)) return { path, text: sourceText }; throw new Error("Open the desktop app to preview workspace files."); },
    installCloudBrowser: async () => { throw new Error("Open the desktop app to install the browser."); },
    listCloudAllowedCommands: async () => [],
    revokeCloudAllowedCommand: async () => undefined,
    getCloudSettings: async () => settings,
    saveCloudSettings: async value => { settings = value; return settings; },
    inspectCloudProvider: async ({ provider }) => connection(provider),
    installCloudProvider: async ({ provider }) => { state[provider] = "sign_in"; return connection(provider); },
    cancelCloudSignIn: async () => undefined,
    disconnectCloudProvider: async ({ provider }) => { state[provider] = "sign_in"; return connection(provider); },
    signInCloudProvider: async ({ provider }) => { if (params.get("login") !== "pending") state[provider] = "ready"; return { message: "Preview connection" }; },
    pickCloudFolders: async () => [],
    saveCloudImages: async ({ files }) => files.map(file => {
      const image = { id: crypto.randomUUID(), name: file.name, mimeType: file.mimeType || "image/png", previewDataUrl: file.dataUrl };
      images.set(image.id, image); return image;
    }),
    getCloudWorkspace: async ({ provider, key }) => key && chats.has(key) ? chats.get(key)! : ({ key: `preview-${provider}`, provider, path: "/preview", state: "idle", compactions: 0, entries: sourceFixture ? [
      { id: "source-prompt", kind: "instruction", at: new Date().toISOString(), text: "Show me how the monitor synchronizes data." },
      { id: "source-answer", kind: "answer", at: new Date().toISOString(), text: "The monitor reads configuration, then publishes status and audit records.\n\n```mermaid\nflowchart LR\n C[Config databases] -->|Settings and control commands| M[Local monitor database]\n M -->|Status and sync progress| C\n M -->|Alerts and scan results| A[Audit databases]\n M -->|Standards data| S[Standard databases]\n```\n\nThe connection check is in [monitor.c](/preview/core/monitor.c:16). See [main.c](/preview/main.c) for the complete file.\n\n```c\n" + sourceText + "```" },
    ] : [], approvals: [] }),
    startCloudTurn: async () => { throw new Error("This is a design preview. Open the desktop app to start work."); },
    sendCloudFollowUp: async () => { throw new Error("Open the conversation preview to try queued prompts and steering."); },
    removeCloudQueuedPrompt: async () => { throw new Error("Open the conversation preview to edit queued prompts."); },
    stopCloudTurn: async () => undefined,
    respondCloudApproval: async () => undefined,
    onCloudWorkspace: () => () => undefined,
    ...(conversationFixture ? previewCloudConversation(images) : {}),
  };
}
