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
  return endpoint?.version === currentVersion ? endpoint : undefined;
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
