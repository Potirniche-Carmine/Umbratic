import { assertAllowedProvider, type UmbraticProviderConfig } from "./provider/local.js";

export type PermissionMode = "normal" | "bypass";
export const runnerToolNames = ["read", "write", "edit", "search", "command", "debugger"] as const;
export type RunnerToolName = (typeof runnerToolNames)[number];

export type RunnerConfig = {
  taskId?: string;
  cwd: string;
  workspaceMode?: "local" | "worktree";
  runtimeProfiles?: string[];
  permissionMode: PermissionMode;
  enabledTools: RunnerToolName[];
  provider: UmbraticProviderConfig;
  system?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runner config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`runner config missing ${name}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headersValue(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (name.trim() && typeof headerValue === "string" && headerValue) {
      headers[name.trim()] = headerValue;
    }
  }
  return Object.keys(headers).length ? headers : undefined;
}

export function isRunnerToolName(value: unknown): value is RunnerToolName {
  return typeof value === "string" && (runnerToolNames as readonly string[]).includes(value);
}

function enabledToolsValue(value: unknown): RunnerToolName[] {
  if (!Array.isArray(value)) return [...runnerToolNames];
  const seen = new Set<RunnerToolName>();
  for (const item of value) {
    if (isRunnerToolName(item)) seen.add(item);
  }
  return runnerToolNames.filter((name) => seen.has(name));
}

function runtimeProfilesValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.trim()) seen.add(item.trim());
  }
  return seen.size ? [...seen] : undefined;
}

export function loadRunnerConfig(): RunnerConfig {
  const raw = process.env.UMBRATIC_RUNNER_CONFIG;
  if (!raw) throw new Error("UMBRATIC_RUNNER_CONFIG is required");
  const config = asRecord(JSON.parse(raw) as unknown);
  const provider = asRecord(config.provider);
  const mtls = config.provider && "mtls" in provider && provider.mtls ? asRecord(provider.mtls) : undefined;
  return {
    taskId: typeof config.taskId === "string" && config.taskId.trim() ? config.taskId.trim() : undefined,
    cwd: stringValue(config.cwd, "cwd"),
    workspaceMode: config.workspaceMode === "worktree" ? "worktree" : "local",
    runtimeProfiles: runtimeProfilesValue(config.runtimeProfiles),
    permissionMode: config.permissionMode === "bypass" ? "bypass" : "normal",
    enabledTools: enabledToolsValue(config.enabledTools),
    system: typeof config.system === "string" ? config.system : undefined,
    provider: assertAllowedProvider({
      id: "company-endpoint",
      name: stringValue(provider.name, "provider.name"),
      baseURL: stringValue(provider.baseURL, "provider.baseURL").replace(/\/+$/, ""),
      chatEndpointPath: optionalString(provider.chatEndpointPath),
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "local",
      modelId: stringValue(provider.modelId, "provider.modelId"),
      headers: headersValue(provider.headers),
      mtls: mtls
        ? {
            caPath: optionalString(mtls.caPath),
            certPath: optionalString(mtls.certPath),
            keyPath: optionalString(mtls.keyPath),
            pfxPath: optionalString(mtls.pfxPath),
            passphrase: optionalString(mtls.passphrase),
            serverName: optionalString(mtls.serverName),
            pinnedServerCertificateSha256: optionalString(mtls.pinnedServerCertificateSha256),
          }
        : undefined,
    }),
  };
}
