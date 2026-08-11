/**
 * The model list a server-mode Veil publishes.
 *
 * The desktop never asks a runtime what it is running — that is Veil's to
 * answer, and `/api/models` is the one route that answers it. The list is
 * gated on the `models.list` feature name: a server too old to advertise it
 * also has no route to call, and the picker stays hidden rather than showing
 * an empty menu that looks like an outage.
 */

import { configuredEndpointRoute, endpointRequestHeaders, type endpointProvider } from "./endpointConfig";
import { getProviderJson } from "./providerClient";
import type { ServerModelInfo } from "../shared/desktopApi";

type EndpointProvider = ReturnType<typeof endpointProvider>;

const maxServerModels = 64;

function modelEntry(value: unknown): ServerModelInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id || id.length > 256) return null;
  const display = typeof record.display === "string" && record.display.trim() ? record.display.trim() : id;
  const contextLength = typeof record.context_length === "number" && Number.isInteger(record.context_length) && record.context_length > 0
    ? record.context_length
    : undefined;
  const capabilities = record.capabilities && typeof record.capabilities === "object" && !Array.isArray(record.capabilities)
    ? record.capabilities as Record<string, unknown>
    : {};
  return {
    id,
    display,
    ...(contextLength === undefined ? {} : { contextLength }),
    reasoning: capabilities.reasoning === true,
    available: record.available === true,
    default: record.default === true,
  };
}

/**
 * Reads the published registry. A tolerant parse on purpose: this list decides
 * what a menu shows, so one entry a newer server describes in a way this build
 * cannot read costs that row, never the whole picker.
 */
export async function fetchServerModels(provider: EndpointProvider): Promise<ServerModelInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await getProviderJson(configuredEndpointRoute(provider.baseUrl, "/api/models"), {
      headers: endpointRequestHeaders(provider),
      mtls: provider.mtls,
      signal: controller.signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return [];
    const payload = response.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? response.json as Record<string, unknown>
      : {};
    const rows = Array.isArray(payload.models) ? payload.models : [];
    return rows
      .slice(0, maxServerModels)
      .map(modelEntry)
      .filter((entry): entry is ServerModelInfo => entry !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
