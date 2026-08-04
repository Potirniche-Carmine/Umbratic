import type { ModelEndpointMode, PublicModelEndpointSettings } from "../shared/desktopApi";

export type ModelEndpointSettings = PublicModelEndpointSettings;

export const defaultModelEndpointSettings: ModelEndpointSettings = {
  mode: "local",
  baseUrl: "http://127.0.0.1:11434",
  modelId: "",
  secret: "",
  secretConfigured: false,
  headers: [
    { name: "", value: "", valueConfigured: false },
    { name: "", value: "", valueConfigured: false },
  ],
};

export function normalizeEndpointHeaders(value: unknown): Array<{ name: string; value: string; valueConfigured: boolean }> {
  const rows = Array.isArray(value) ? value : [];
  const headers = rows.slice(0, 2).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { name: "", value: "", valueConfigured: false };
    const record = row as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "",
      value: typeof record.value === "string" ? record.value : "",
      valueConfigured: record.valueConfigured === true,
    };
  });
  while (headers.length < 2) headers.push({ name: "", value: "", valueConfigured: false });
  return headers;
}

export function defaultEndpointBaseUrlForMode(mode: ModelEndpointMode): string {
  return mode === "local" ? "http://127.0.0.1:11434" : "https://your-veil-server.example";
}

export function normalizeEndpointSettings(value: unknown): ModelEndpointSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultModelEndpointSettings };
  const settings = value as Partial<ModelEndpointSettings>;
  const mode = settings.mode === "local" || settings.mode === "server" ? settings.mode : defaultModelEndpointSettings.mode;
  return {
    mode,
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl : defaultEndpointBaseUrlForMode(mode),
    modelId: typeof settings.modelId === "string" ? settings.modelId : mode === "local" ? "" : "veil-managed",
    secret: typeof settings.secret === "string" ? settings.secret : "",
    secretConfigured: settings.secretConfigured === true,
    headers: normalizeEndpointHeaders(settings.headers),
  };
}

export function endpointDefaultsForMode(mode: ModelEndpointMode): ModelEndpointSettings {
  return {
    mode,
    baseUrl: defaultEndpointBaseUrlForMode(mode),
    modelId: mode === "local" ? "" : "veil-managed",
    secret: "",
    secretConfigured: false,
    headers: normalizeEndpointHeaders([]),
  };
}

export function endpointValidationMessage(settings: ModelEndpointSettings): string | null {
  try {
    const url = new URL(settings.baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an HTTP or HTTPS URL.";
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (settings.mode === "local" && hostname !== "localhost" && hostname !== "::1" && !hostname.startsWith("127.")) {
      return "Local mode only connects to a model runtime on this computer.";
    }
  } catch {
    return `${settings.mode === "local" ? "Runtime" : "Server"} URL is invalid.`;
  }
  if (settings.mode === "local" && !settings.modelId.trim()) return "Select a model installed in your local runtime.";
  return null;
}
