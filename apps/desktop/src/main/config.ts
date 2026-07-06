import { env } from "node:process";

import type { HarnessProfileId, LocalProviderId, ModelEndpointMode, ModelEndpointSoftware, TaskState } from "./types";

export type EndpointMtlsConfig = {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  pfxPath?: string;
  passphrase?: string;
  serverName?: string;
  pinnedServerCertificateSha256?: string;
};

const configuredEndpointBaseUrl =
  env.UMBRATIC_VEIL_BASE_URL ||
  env.UMBRATIC_MANAGED_MODEL_BASE_URL ||
  env.UMBRATIC_MODEL_BASE_URL ||
  env.OLLAMA_BASE_URL ||
  env.UMBRATIC_VLLM_BASE_URL ||
  env.VLLM_BASE_URL ||
  "";

export const defaultEndpointBaseUrl =
  configuredEndpointBaseUrl ||
  "http://127.0.0.1:8080";
export const defaultEndpointApiKey =
  env.UMBRATIC_VEIL_TOKEN || env.UMBRATIC_MODEL_API_KEY || env.OLLAMA_API_KEY || env.VLLM_API_KEY || "";
export const defaultEndpointModelId = "veil-managed";

export function isModelEndpointMode(value: unknown): value is ModelEndpointMode {
  return value === "local" || value === "server";
}

export function isModelEndpointSoftware(value: unknown): value is ModelEndpointSoftware {
  return value === "ollama" || value === "vllm";
}

export function defaultEndpointSoftware(mode: ModelEndpointMode, baseUrl = defaultEndpointBaseUrl): ModelEndpointSoftware {
  const normalized = baseUrl.toLowerCase();
  if (env.UMBRATIC_MANAGED_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MANAGED_MODEL_SOFTWARE;
  }
  if (env.UMBRATIC_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MODEL_SOFTWARE;
  }
  if (env.OLLAMA_BASE_URL || normalized.includes("11434") || normalized.includes("ollama")) return "ollama";
  if (env.UMBRATIC_VLLM_BASE_URL || env.VLLM_BASE_URL || normalized.includes("vllm") || normalized.includes("8000")) return "vllm";
  return mode === "local" ? "ollama" : "vllm";
}

export function managedModelEndpointDefaults():
  | {
      mode?: ModelEndpointMode;
      software?: ModelEndpointSoftware;
      baseUrl?: string;
      secret?: string;
    }
  | undefined {
  const mode = isModelEndpointMode(env.UMBRATIC_MANAGED_ENDPOINT_MODE) ? env.UMBRATIC_MANAGED_ENDPOINT_MODE : undefined;
  const software = isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE) ? env.UMBRATIC_MANAGED_MODEL_SOFTWARE : undefined;
  const baseUrl = env.UMBRATIC_MANAGED_MODEL_BASE_URL?.trim();
  const secret = env.UMBRATIC_MANAGED_MODEL_API_KEY ?? undefined;
  const managed = {
    mode,
    software,
    baseUrl: baseUrl || undefined,
    secret,
  };
  return Object.values(managed).some((value) => value !== undefined) ? managed : undefined;
}

export function endpointEditingAllowed(): boolean {
  const value = env.UMBRATIC_ALLOW_ENDPOINT_EDIT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export const defaultHarnessProfileId: HarnessProfileId = "engineering";

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
}

export function defaultEndpointBaseUrlForSoftware(mode: ModelEndpointMode, software: ModelEndpointSoftware): string {
  void software;
  if (mode === "local") return "http://127.0.0.1:8080";
  if (configuredEndpointBaseUrl) return configuredEndpointBaseUrl;
  return "https://your-veil-server.example";
}

function optionalEnv(name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export const defaultEndpointMtlsConfig: EndpointMtlsConfig | undefined = (() => {
  const mtls: EndpointMtlsConfig = {
    caPath: optionalEnv("UMBRATIC_MODEL_MTLS_CA_PATH"),
    certPath: optionalEnv("UMBRATIC_MODEL_MTLS_CERT_PATH"),
    keyPath: optionalEnv("UMBRATIC_MODEL_MTLS_KEY_PATH"),
    pfxPath: optionalEnv("UMBRATIC_MODEL_MTLS_PFX_PATH"),
    passphrase: optionalEnv("UMBRATIC_MODEL_MTLS_PASSPHRASE"),
    serverName: optionalEnv("UMBRATIC_MODEL_TLS_SERVER_NAME"),
    pinnedServerCertificateSha256: optionalEnv("UMBRATIC_MODEL_TLS_PIN_SHA256"),
  };
  return Object.values(mtls).some(Boolean) ? mtls : undefined;
})();

export const workspaceContextVerificationPrompt = [
  "The workspace file list included with each request is a bounded preview, not a complete filesystem inventory.",
  "When the user asks about all, existing, current, or accurate files, folders, subfolders, or project structure, verify with workspace tools before answering: use the read tool to list known directories, including nested directory inventories, follow directory read continuation offsets when a listing is partial, and use the search tool for path or content matches.",
].join(" ");

export const localProviderCatalog: Array<{
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
}> = [
  {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    baseUrl: defaultEndpointBaseUrl,
    apiKey: defaultEndpointApiKey,
    mtls: defaultEndpointMtlsConfig,
  },
];

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);
