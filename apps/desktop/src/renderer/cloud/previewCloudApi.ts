import { previewCodexModels } from "./previewCodexModels";
import { defaultCloudSettings, type CloudApi, type CloudConnection, type CloudProvider } from "../../shared/cloud";

/** Browser-only design fixtures. Never installs, starts, or authenticates a runtime. */
export function createPreviewCloudApi(): CloudApi {
  let settings = defaultCloudSettings();
  const defaults = defaultCloudSettings();
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "cloud") settings.mode = "cloud";
  if (params.get("provider") === "claude") settings.provider = "claude";
  const initial = params.get("connection");
  const state: Record<CloudProvider, CloudConnection["state"]> = {
    codex: initial === "missing" || initial === "sign_in" ? initial : "ready",
    claude: initial === "missing" || initial === "sign_in" ? initial : "ready",
  };
  function connection(provider: CloudProvider): CloudConnection {
    return { provider, state: state[provider], message: "Preview", account: state[provider] === "ready" ? "Preview account" : undefined,
      models: state[provider] !== "ready" ? [] : provider === "codex" ? previewCodexModels : [...new Set(Object.values(defaults.providers[provider].roles).map(choice => choice.model))].map(id => ({
        id, label: id === "gpt-6.1-sol" ? "GPT-6.1 Sol" : id === "gpt-6.1-terra" ? "GPT-6.1 Terra" : id === "claude-opus-5-5" ? "Opus 5.5" : "Sonnet 5.5",
        efforts: ["low", "medium", "high", "xhigh"],
      })),
    };
  }
  return {
    readCloudFile: async () => { throw new Error("Open the desktop app to preview workspace files."); },
    getCloudSettings: async () => settings,
    saveCloudSettings: async value => { settings = value; return settings; },
    inspectCloudProvider: async ({ provider }) => connection(provider),
    installCloudProvider: async ({ provider }) => { state[provider] = "sign_in"; return connection(provider); },
    cancelCloudSignIn: async () => undefined,
    signInCloudProvider: async ({ provider }) => { if (params.get("login") !== "pending") state[provider] = "ready"; return { message: "Preview connection" }; },
    pickCloudFolders: async () => [],
    saveCloudImages: async ({ files }) => files.map(file => ({ id: crypto.randomUUID(), name: file.name, mimeType: file.mimeType || "image/png", previewDataUrl: file.dataUrl })),
    getCloudWorkspace: async ({ provider }) => ({ key: `preview-${provider}`, provider, path: "/preview", state: "idle", compactions: 0, entries: [], approvals: [] }),
    startCloudTurn: async () => { throw new Error("This is a design preview. Open the desktop app to start work."); },
    stopCloudTurn: async () => undefined,
    resetCloudContext: async () => { throw new Error("No runtime is connected in this preview."); },
    respondCloudApproval: async () => undefined,
    onCloudWorkspace: () => () => undefined,
  };
}
