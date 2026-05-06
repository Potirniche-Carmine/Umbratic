import { assertAllowedProvider, type AegisProviderConfig } from "./provider/local.js";

export type PermissionMode = "normal" | "bypass";

export type RunnerConfig = {
  taskId?: string;
  cwd: string;
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

export function loadRunnerConfig(): RunnerConfig {
  const raw = process.env.AEGIS_RUNNER_CONFIG;
  if (!raw) throw new Error("AEGIS_RUNNER_CONFIG is required");
  const config = asRecord(JSON.parse(raw) as unknown);
  const provider = asRecord(config.provider);
  return {
    taskId: typeof config.taskId === "string" && config.taskId.trim() ? config.taskId.trim() : undefined,
    cwd: stringValue(config.cwd, "cwd"),
    permissionMode: config.permissionMode === "bypass" ? "bypass" : "normal",
    system: typeof config.system === "string" ? config.system : undefined,
    provider: assertAllowedProvider({
      id: provider.id === "company-model" ? "company-model" : "local-lmstudio",
      name: stringValue(provider.name, "provider.name"),
      baseURL: stringValue(provider.baseURL, "provider.baseURL").replace(/\/+$/, ""),
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "local",
      modelId: stringValue(provider.modelId, "provider.modelId"),
    }),
  };
}
