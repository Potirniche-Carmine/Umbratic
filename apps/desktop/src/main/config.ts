import { env } from "node:process";

import type { HarnessProfileId, LocalProviderId, ModelEndpointMode, TaskState } from "./types";

export type EndpointMtlsConfig = {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  serverName?: string;
  pinnedServerCertificateSha256?: string;
};

// One name per setting. The alias chains meant three spellings could each be
// the live value, and which one won depended on an ordering nobody could see
// from the place the variable was set.
const configuredEndpointBaseUrl = env.UMBRATIC_VEIL_BASE_URL || "";

export const defaultEndpointBaseUrl =
  configuredEndpointBaseUrl ||
  "https://your-veil-server.example";
export const defaultEndpointApiKey = env.UMBRATIC_VEIL_TOKEN || "";
export const defaultEndpointModelId = "veil-managed";
export const defaultLocalModelId = env.UMBRATIC_LOCAL_MODEL_ID || "";

export function isModelEndpointMode(value: unknown): value is ModelEndpointMode {
  return value === "local" || value === "server";
}

export function defaultModelEndpointMode(): ModelEndpointMode {
  if (isModelEndpointMode(env.UMBRATIC_DEFAULT_ENDPOINT_MODE)) return env.UMBRATIC_DEFAULT_ENDPOINT_MODE;
  return configuredEndpointBaseUrl ? "server" : "local";
}

export function managedModelEndpointDefaults():
  | {
      mode?: ModelEndpointMode;
      baseUrl?: string;
      secret?: string;
    }
  | undefined {
  const mode = isModelEndpointMode(env.UMBRATIC_MANAGED_ENDPOINT_MODE) ? env.UMBRATIC_MANAGED_ENDPOINT_MODE : undefined;
  const baseUrl = env.UMBRATIC_MANAGED_MODEL_BASE_URL?.trim();
  const secret = env.UMBRATIC_MANAGED_MODEL_API_KEY ?? undefined;
  const managed = {
    mode,
    baseUrl: baseUrl || undefined,
    secret,
  };
  return Object.values(managed).some((value) => value !== undefined) ? managed : undefined;
}

export function endpointEditingAllowed(): boolean {
  const value = env.UMBRATIC_ALLOW_ENDPOINT_EDIT?.trim().toLowerCase();
  if (!value) return true;
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

export function localEndpointForced(): boolean {
  const value = env.UMBRATIC_FORCE_LOCAL_ENDPOINT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export const defaultHarnessProfileId: HarnessProfileId = "engineering";

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
}

// Local mode has no configurable address: the app starts its own llama-server
// on a loopback port it reserved, and only Veil is ever told where. The field
// stays in the stored shape because the endpoint record is validated by its
// exact key set, but its local value is always empty.
export function defaultEndpointBaseUrlForMode(mode: ModelEndpointMode): string {
  if (mode === "local") return "";
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
    serverName: optionalEnv("UMBRATIC_MODEL_TLS_SERVER_NAME"),
    pinnedServerCertificateSha256: optionalEnv("UMBRATIC_MODEL_TLS_PIN_SHA256"),
  };
  return Object.values(mtls).some(Boolean) ? mtls : undefined;
})();

/**
 * The one endpoint this app talks to. It was a catalog with a find-by-id lookup
 * and an allowlist alongside, all to arbitrate between a single entry — Veil is
 * the only model-facing surface by design, so there was never a second one to
 * choose between.
 */
export const companyEndpoint: {
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
} = {
  providerId: "company-endpoint",
  providerName: "Umbratic Veil",
  baseUrl: defaultEndpointBaseUrl,
  apiKey: defaultEndpointApiKey,
  mtls: defaultEndpointMtlsConfig,
};

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);
