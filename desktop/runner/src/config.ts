import { assertAllowedProvider, type AegisProviderConfig } from "./provider/local.js";

export type PermissionMode = "normal" | "bypass";

export type RunnerConfig = {
  taskId?: string;
  cwd: string;
  workspaceMode?: "local" | "worktree";
  permissionMode: PermissionMode;
  provider: AegisProviderConfig;
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

export function loadRunnerConfig(): RunnerConfig {
  const raw = process.env.AEGIS_RUNNER_CONFIG;
  if (!raw) throw new Error("AEGIS_RUNNER_CONFIG is required");
  const config = asRecord(JSON.parse(raw) as unknown);
  const provider = asRecord(config.provider);
  const mtls = config.provider && "mtls" in provider && provider.mtls ? asRecord(provider.mtls) : undefined;
  return {
    taskId: typeof config.taskId === "string" && config.taskId.trim() ? config.taskId.trim() : undefined,
    cwd: stringValue(config.cwd, "cwd"),
    workspaceMode: config.workspaceMode === "worktree" ? "worktree" : "local",
    permissionMode: config.permissionMode === "bypass" ? "bypass" : "normal",
    system: typeof config.system === "string" ? config.system : undefined,
    provider: assertAllowedProvider({
      id: provider.id === "company-model" ? "company-model" : "local-endpoint",
      name: stringValue(provider.name, "provider.name"),
      baseURL: stringValue(provider.baseURL, "provider.baseURL").replace(/\/+$/, ""),
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "local",
      modelId: stringValue(provider.modelId, "provider.modelId"),
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
