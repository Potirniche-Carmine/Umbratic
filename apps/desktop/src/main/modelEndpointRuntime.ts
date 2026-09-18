import { configuredEndpointRoute, endpointHealthRoute, endpointRequestHeaders, type endpointProvider } from "./endpointConfig";
import { getProviderJson } from "./providerClient";
import { readContextLengthSetting } from "./storage";
import type { LocalModelInfo, ServiceStatus } from "./types";
import { probeVeilContextLength } from "./veilContext";
import { parseVeilFeatures } from "./veilFeatures";
import type { TelemetryUploadEndpoint } from "./telemetrySync";

type EndpointProvider = ReturnType<typeof endpointProvider>;

export async function modelWithFreshContextLength(selected: LocalModelInfo, provider: EndpointProvider): Promise<LocalModelInfo> {
  const detected = await probeVeilContextLength({
    baseUrl: provider.baseUrl,
    headers: endpointRequestHeaders(provider),
    mtls: provider.mtls,
  });
  return { ...selected, contextLength: detected ?? readContextLengthSetting() };
}

export function telemetryUploadEndpoint(provider: EndpointProvider): TelemetryUploadEndpoint {
  return {
    url: configuredEndpointRoute(provider.baseUrl, "/api/telemetry"),
    headers: endpointRequestHeaders(provider),
    mtls: provider.mtls,
  };
}

export async function checkEndpointHealth(provider: EndpointProvider): Promise<{
  status: ServiceStatus;
  message?: string;
  capabilities?: NonNullable<LocalModelInfo["capabilities"]>;
  features?: string[];
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const healthRoute = endpointHealthRoute(provider);
    const response = await getProviderJson(healthRoute, {
      headers: endpointRequestHeaders(provider),
      mtls: provider.mtls,
      signal: controller.signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.text.trim().slice(0, 160);
      return {
        status: "unavailable",
        message: `Health check failed at ${new URL(healthRoute).pathname} with ${response.statusCode} ${response.statusMessage}${detail ? `: ${detail}` : ""}`,
      };
    }
    const payload = response.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? response.json as Record<string, unknown>
      : {};
    const raw = payload.capabilities && typeof payload.capabilities === "object" && !Array.isArray(payload.capabilities)
      ? payload.capabilities as Record<string, unknown>
      : {};
    if (payload.state === "model_not_configured") {
      return { status: "unavailable", message: "No model is configured.", features: parseVeilFeatures(payload) };
    }
    return {
      status: "ready",
      message: `Health check passed at ${new URL(healthRoute).pathname}.`,
      capabilities: {
        parallelToolCalls: raw.parallel_tool_calls === true,
        vision: raw.vision === true,
        reasoning: raw.reasoning === true,
      },
      // A server too old to advertise features reports none, which is what an
      // empty list already means. There is no third "unknown" state to handle.
      features: parseVeilFeatures(payload),
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error && error.name === "AbortError"
        ? "Health check timed out."
        : `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
