export type CloudProvider = "codex" | "claude";
export type AppMode = "private" | "cloud";
export type CloudRole = "routine" | "architecture" | "research";
export type CloudEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type CloudModelChoice = { model: string; effort: CloudEffort };
export type CloudModel = { id: string; label: string; efforts: CloudEffort[]; defaultEffort?: CloudEffort; unavailableReason?: string };
export type CloudProviderSettings = {
  executable: string;
  orchestrator: CloudModelChoice;
  roles: Record<CloudRole, CloudModelChoice>;
};
export type CloudSettings = {
  contextPolicyVersion?: number;
  workspaceRepositoryIds?: string[];
  mode: AppMode;
  provider: CloudProvider;
  providers: Record<CloudProvider, CloudProviderSettings>;
  subagents: boolean;
  showToolActivity: boolean;
  idleResetHours: number;
  resetAfterCompactions: number;
};
export type CloudConnection = {
  provider: CloudProvider;
  state: "ready" | "sign_in" | "missing" | "unavailable" | "unsupported_account";
  message: string;
  account?: string;
  accountEmail?: string;
  planName?: string;
  usage?: CloudUsage;
  version?: string;
  models: CloudModel[];
};
export type CloudLimit = { id: string; label: string; usedPercent: number; resetsAt?: string };
export type CloudUsage = { limits: CloudLimit[]; fetchedAt: string };
export type CloudImage = { id: string; name: string; mimeType: string; previewDataUrl: string };
export type CloudImageInput = { name: string; dataUrl: string; mimeType?: string };
export type CloudTool = { id: string; label: string; detail?: string; status: "running" | "completed" | "failed" | "stopped" };
export type CloudEntry = { id: string; kind: "instruction" | "answer" | "activity" | "context" | "error"; text: string; at: string; tool?: CloudTool; images?: CloudImage[] };
export type CloudApproval = { id: string; title: string; detail: string; questions?: { id: string; question: string; options: string[] }[] };
export type CloudWorkspace = {
  key: string;
  provider: CloudProvider;
  path: string;
  paths?: string[];
  usage?: CloudUsage;
  sessionId?: string;
  account?: string;
  lastActiveAt?: string;
  compactions: number;
  state: "idle" | "running" | "waiting";
  entries: CloudEntry[];
  approvals: CloudApproval[];
  contextWindow?: number;
  inputTokens?: number;
};
export type CloudWorkspaceInput = { provider: CloudProvider; repositoryId?: string; repositoryIds?: string[] };
export type CloudApi = {
  pickCloudFolders(): Promise<import("./desktopApiTypes").RepositoryInfo[]>;
  saveCloudImages(input: { files: CloudImageInput[] }): Promise<CloudImage[]>;
  getCloudSettings(): Promise<CloudSettings>;
  saveCloudSettings(input: CloudSettings): Promise<CloudSettings>;
  inspectCloudProvider(input: { provider: CloudProvider }): Promise<CloudConnection>;
  signInCloudProvider(input: { provider: CloudProvider }): Promise<{ message: string }>;
  cancelCloudSignIn(input: { provider: CloudProvider }): Promise<void>;
  installCloudProvider(input: { provider: CloudProvider }): Promise<CloudConnection>;
  getCloudWorkspace(input: CloudWorkspaceInput): Promise<CloudWorkspace>;
  startCloudTurn(input: CloudWorkspaceInput & { prompt: string; imageIds?: string[] }): Promise<CloudWorkspace>;
  stopCloudTurn(input: { key: string }): Promise<void>;
  resetCloudContext(input: { key: string }): Promise<CloudWorkspace>;
  respondCloudApproval(input: { key: string; id: string; allow: boolean; answers?: Record<string, string> }): Promise<void>;
  onCloudWorkspace(callback: (workspace: CloudWorkspace) => void): () => void;
};
export const cloudRoleLabels: Record<CloudRole, string> = {
  routine: "Routine coding", architecture: "Difficult implementation", research: "Research & extraction",
};
export const cloudEffortLabels: Record<CloudEffort, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra",
};
export function defaultCloudSettings(): CloudSettings {
  const sol = (effort: CloudEffort): CloudModelChoice => ({ model: "gpt-6.1-sol", effort });
  const opus = (effort: CloudEffort): CloudModelChoice => ({ model: "claude-opus-5-5", effort });
  return {
    mode: "private", provider: "codex", subagents: true, showToolActivity: true, idleResetHours: 3, resetAfterCompactions: 0, contextPolicyVersion: 2, workspaceRepositoryIds: [],
    providers: {
      codex: { executable: "", orchestrator: sol("medium"), roles: {
        routine: sol("medium"), architecture: sol("xhigh"),
        research: { model: "gpt-6.1-terra", effort: "high" },
      } },
      claude: { executable: "", orchestrator: opus("medium"), roles: {
        routine: opus("medium"), architecture: opus("xhigh"),
        research: { model: "claude-sonnet-5-5", effort: "medium" },
      } },
    },
  };
}
export function isCloudProvider(value: unknown): value is CloudProvider { return value === "codex" || value === "claude"; }
export function isCloudEffort(value: unknown): value is CloudEffort {
  return typeof value === "string" && Object.hasOwn(cloudEffortLabels, value);
}
export function validateCloudSettings(value: CloudSettings): CloudSettings {
  if (!value || !["private", "cloud"].includes(value.mode) || !isCloudProvider(value.provider)) throw new Error("Invalid workspace mode.");
  if (typeof value.subagents !== "boolean") throw new Error("Invalid workflow setting.");
  // Migrate the first 0.0.3 preview without losing provider or role choices.
  const showToolActivity = Object.hasOwn(value, "showToolActivity") ? value.showToolActivity : true;
  if (typeof showToolActivity !== "boolean") throw new Error("Invalid tool activity setting.");
  const legacy = value as CloudSettings & { dailyReset?: boolean };
  const idleResetHours = Object.hasOwn(value, "idleResetHours") ? value.idleResetHours : legacy.dailyReset === false ? 0 : 3;
  if (!Number.isInteger(idleResetHours) || idleResetHours < 0 || idleResetHours > 24) throw new Error("Choose an inactivity period of 1 to 24 hours, or Never.");
  if (!Number.isInteger(value.resetAfterCompactions) || value.resetAfterCompactions < 0 || value.resetAfterCompactions > 20) throw new Error("Choose between 0 and 20 compactions.");
  for (const provider of ["codex", "claude"] as const) {
    const config = value.providers?.[provider];
    if (!config || typeof config.executable !== "string" || config.executable.length > 4096) throw new Error("Invalid runtime path.");
    for (const choice of [config.orchestrator, ...Object.keys(cloudRoleLabels).map(role => config.roles?.[role as CloudRole])]) {
      if (!choice || typeof choice.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/()[\]-]{0,159}$/.test(choice.model) || !isCloudEffort(choice.effort)) throw new Error("Invalid model preset.");
    }
  }
  const workspaceRepositoryIds = value.workspaceRepositoryIds ?? [];
  if (!Array.isArray(workspaceRepositoryIds) || workspaceRepositoryIds.length > 16 || workspaceRepositoryIds.some(id => typeof id !== "string" || id.length > 200)) throw new Error("Choose up to 16 workspace folders.");
  const resetAfterCompactions = !value.contextPolicyVersion && value.resetAfterCompactions === 5 ? 0 : value.resetAfterCompactions;
  const result = structuredClone({ ...value, idleResetHours, showToolActivity, resetAfterCompactions, workspaceRepositoryIds, contextPolicyVersion: 2 }) as CloudSettings & { dailyReset?: boolean; review?: boolean };
  delete result.dailyReset;
  delete result.review;
  for (const provider of ["codex", "claude"] as const) delete (result.providers[provider].roles as Partial<Record<string, CloudModelChoice>>).review;
  return result;
}
export function modelChoiceError(choice: CloudModelChoice, models: CloudModel[]): string | undefined {
  const model = models.find(item => item.id === choice.model);
  if (!model) return `${choice.model} is not available from this runtime. Choose another model in Settings.`;
  if (model.unavailableReason) return model.unavailableReason;
  if (model.efforts.length && !model.efforts.includes(choice.effort)) return `${model.label} does not report support for ${cloudEffortLabels[choice.effort]} effort.`;
  return undefined;
}
export function contextResetReason(workspace: CloudWorkspace, settings: CloudSettings, now = new Date()): string | undefined {
  if (!workspace.sessionId || workspace.state !== "idle") return undefined;
  const lastActive = Date.parse(workspace.lastActiveAt || workspace.entries?.at(-1)?.at || "");
  if (settings.idleResetHours > 0 && Number.isFinite(lastActive) && now.getTime() - lastActive >= settings.idleResetHours * 3_600_000) {
    return `Fresh context after ${settings.idleResetHours} hours away.`;
  }
  if (settings.resetAfterCompactions > 0 && workspace.compactions >= settings.resetAfterCompactions) return `Fresh context after ${workspace.compactions} compactions.`;
  return undefined;
}
