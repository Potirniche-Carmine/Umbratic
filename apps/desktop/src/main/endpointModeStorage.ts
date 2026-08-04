import type { ActiveModelEndpointSettings, ModelEndpointMode } from "./types";

export type RawModelEndpointSettings = Partial<Omit<ActiveModelEndpointSettings, "headers" | "secret">> & {
  secret?: unknown;
  headers?: unknown;
};

type EndpointModeSettings = {
  modelEndpoint?: RawModelEndpointSettings;
  modelEndpoints?: Partial<Record<ModelEndpointMode, RawModelEndpointSettings>>;
};

// A stored endpoint is defined by its exact shape. Anything else — including a
// row left behind by an older field set — is discarded, never interpreted.
const storedEndpointFields = ["mode", "baseUrl", "modelId", "secret", "headers"];

function normalizeStoredEndpoint(
  endpoint: RawModelEndpointSettings | undefined,
): RawModelEndpointSettings | undefined {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return undefined;
  const keys = Object.keys(endpoint);
  if (keys.length !== storedEndpointFields.length) return undefined;
  if (!storedEndpointFields.every((field) => keys.includes(field))) return undefined;
  if (endpoint.mode !== "local" && endpoint.mode !== "server") return undefined;
  if (typeof endpoint.baseUrl !== "string" || typeof endpoint.modelId !== "string") return undefined;
  if (!Array.isArray(endpoint.headers)) return undefined;
  return endpoint;
}

export function activeStoredEndpoint(settings: EndpointModeSettings): RawModelEndpointSettings | undefined {
  return normalizeStoredEndpoint(settings.modelEndpoint);
}

export function storedEndpointForMode(
  settings: EndpointModeSettings,
  mode: ModelEndpointMode,
): RawModelEndpointSettings | undefined {
  const stored = normalizeStoredEndpoint(settings.modelEndpoints?.[mode]);
  return stored?.mode === mode ? stored : undefined;
}

export function endpointModesWithNext(
  settings: EndpointModeSettings,
  next: RawModelEndpointSettings,
): Partial<Record<ModelEndpointMode, RawModelEndpointSettings>> {
  const endpoints = { ...settings.modelEndpoints };
  if (next.mode === "local" || next.mode === "server") endpoints[next.mode] = next;
  return endpoints;
}
