import type { LocalModelInfo } from "../shared/desktopApi";
import { companyEndpoint } from "./config";
import { currentCompanySessionToken } from "./companyIdentity";
import { currentLocalVeilConnection } from "./localVeil";
import { readModelEndpointSettings } from "./storage";

const veilManagedModelId = "veil-managed";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function endpointHeaders(
  headers: ReturnType<typeof readModelEndpointSettings>["headers"],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name || name.toLowerCase() === "authorization" || !header.value) continue;
    next[name] = header.value;
  }
  return next;
}

export function endpointProvider(): typeof companyEndpoint & {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const provider = companyEndpoint;
  const settings = readModelEndpointSettings();
  const localConnection = settings.mode === "local" ? currentLocalVeilConnection() : null;
  return {
    ...provider,
    providerName: "Umbratic Veil",
    baseUrl: normalizeBaseUrl(localConnection?.baseUrl ?? settings.baseUrl),
    apiKey: localConnection?.authToken ?? currentCompanySessionToken(),
    headers: settings.mode === "local" ? {} : endpointHeaders(settings.headers),
    mtls: settings.mode === "server" ? provider.mtls : undefined,
  };
}

export function configuredEndpointModel(): LocalModelInfo {
  const provider = endpointProvider();
  const settings = readModelEndpointSettings();
  return {
    providerId: provider.providerId,
    providerName: provider.providerName,
    modelId: veilManagedModelId,
    displayName: settings.mode === "local" ? settings.modelId : provider.providerName,
    baseUrl: provider.baseUrl,
  };
}

/**
 * Joins a route onto the configured base URL, absorbing the two ways they
 * overlap in practice: a base that already ends in /vN, and a base whose last
 * segment repeats the route's first.
 *
 * This existed twice, byte for byte, and one copy fed the assertion that a
 * runner is only ever pointed at an approved Veil chat route. Two copies of the
 * function deciding what "approved" means is one copy too many.
 */
export function configuredEndpointRoute(baseUrl: string, route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let normalizedRoute = route.replace(/^\/+/, "");
  if (/\/v\d+$/i.test(new URL(normalizedBaseUrl).pathname) && /^v\d+\//i.test(normalizedRoute)) {
    normalizedRoute = normalizedRoute.replace(/^v\d+\//i, "");
  }
  const baseSegment = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "").split("/").filter(Boolean).at(-1);
  const routeSegment = normalizedRoute.split("/").filter(Boolean)[0];
  if (baseSegment && baseSegment === routeSegment) {
    normalizedRoute = normalizedRoute.split("/").filter(Boolean).slice(1).join("/");
  }
  return new URL(normalizedRoute, `${normalizedBaseUrl}/`).toString();
}

export function endpointHealthRoute(provider: ReturnType<typeof endpointProvider>): string {
  return configuredEndpointRoute(provider.baseUrl, "/api/health");
}

export function endpointRequestHeaders(provider: ReturnType<typeof endpointProvider>): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  Object.assign(headers, provider.headers);
  return headers;
}

export function companyTransportOptions(): {
  headers: Record<string, string>;
  mtls: typeof companyEndpoint["mtls"];
} {
  const settings = readModelEndpointSettings();
  return {
    headers: endpointHeaders(settings.headers),
    mtls: companyEndpoint.mtls,
  };
}
