import type { EndpointMtlsConfig } from "./config";
import { getProviderJson } from "./providerClient";

export type VeilContextEndpoint = {
  baseUrl: string;
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
};

function contextRoute(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "")}/api/model/context`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function contextLengthFromVeilPayload(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.context_length ?? record.contextLength;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

export async function probeVeilContextLength(endpoint: VeilContextEndpoint, timeoutMs = 2_500): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await getProviderJson(contextRoute(endpoint.baseUrl), {
      headers: endpoint.headers,
      mtls: endpoint.mtls,
      signal: controller.signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    return contextLengthFromVeilPayload(response.json);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
