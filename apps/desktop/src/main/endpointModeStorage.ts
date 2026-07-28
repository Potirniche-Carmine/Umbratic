import type { ActiveModelEndpointSettings, ModelEndpointMode } from "./types";

export type RawModelEndpointSettings = Partial<Omit<ActiveModelEndpointSettings, "headers" | "secret">> & {
  version?: unknown;
  secret?: unknown;
  headers?: unknown;
};

type EndpointModeSettings = {
  modelEndpoint?: RawModelEndpointSettings;
  modelEndpoints?: Partial<Record<ModelEndpointMode, RawModelEndpointSettings>>;
};

function normalizeStoredEndpoint(
  endpoint: RawModelEndpointSettings | undefined,
  currentVersion: number,
): RawModelEndpointSettings | undefined {
  if (!endpoint) return undefined;
  if (endpoint.version === currentVersion || endpoint.mode !== "local") return endpoint;
  // Older records stored the local Veil URL instead of the model-runtime URL.
  return { mode: "local", software: endpoint.software };
}

export function activeStoredEndpoint(
  settings: EndpointModeSettings,
  currentVersion: number,
): RawModelEndpointSettings | undefined {
  return normalizeStoredEndpoint(settings.modelEndpoint, currentVersion);
}

export function storedEndpointForMode(
  settings: EndpointModeSettings,
  mode: ModelEndpointMode,
  currentVersion: number,
): RawModelEndpointSettings | undefined {
  const stored = normalizeStoredEndpoint(settings.modelEndpoints?.[mode], currentVersion);
  if (stored?.mode === mode) return stored;
  const active = activeStoredEndpoint(settings, currentVersion);
  return active?.mode === mode ? active : undefined;
}

export function endpointModesWithNext(
  settings: EndpointModeSettings,
  next: RawModelEndpointSettings,
  currentVersion: number,
): Partial<Record<ModelEndpointMode, RawModelEndpointSettings>> {
  const endpoints = { ...settings.modelEndpoints };
  const active = activeStoredEndpoint(settings, currentVersion);
  if ((active?.mode === "local" || active?.mode === "server") && !endpoints[active.mode]) {
    endpoints[active.mode] = active;
  }
  if (next.mode === "local" || next.mode === "server") endpoints[next.mode] = next;
  return endpoints;
}
