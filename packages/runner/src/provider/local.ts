export type UmbraticProviderConfig = {
  id: "company-endpoint";
  name: string;
  baseURL: string;
  chatEndpointPath?: string;
  apiKey: string;
  modelId: string;
  headers?: Record<string, string>;
  mtls?: UmbraticProviderMtlsConfig;
};

export type UmbraticProviderMtlsConfig = {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  pfxPath?: string;
  passphrase?: string;
  serverName?: string;
  pinnedServerCertificateSha256?: string;
};

export type RunnerModelBoundary = "development" | "managed";

export function configuredProviderEndpointUrl(baseURL: string, endpointPath?: string): string {
  const chatCompletionsUrl = (rawBaseURL: string) => {
    const base = rawBaseURL.replace(/\/+$/, "");
    return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  };
  if (!endpointPath?.trim()) return chatCompletionsUrl(baseURL);
  const trimmed = endpointPath.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const normalizedBaseUrl = baseURL.replace(/\/+$/, "");
  let normalizedPath = trimmed.replace(/^\/+/, "");
  if (/\/v\d+$/i.test(new URL(normalizedBaseUrl).pathname) && /^v\d+\//i.test(normalizedPath)) {
    normalizedPath = normalizedPath.replace(/^v\d+\//i, "");
  }
  const baseSegment = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "").split("/").filter(Boolean).at(-1);
  const routeSegment = normalizedPath.split("/").filter(Boolean)[0];
  if (baseSegment && baseSegment === routeSegment) {
    normalizedPath = normalizedPath.split("/").filter(Boolean).slice(1).join("/");
  }
  return new URL(normalizedPath, `${normalizedBaseUrl}/`).toString();
}

export function isApprovedVeilChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      /^\/api\/(?:engineering|marketing|sales)\/chat\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

export function assertAllowedProvider(
  config: UmbraticProviderConfig,
  options: { modelBoundary?: RunnerModelBoundary } = {},
): UmbraticProviderConfig {
  if (config.id !== "company-endpoint") {
    throw new Error("provider id must be company-endpoint");
  }
  const url = new URL(config.baseURL);
  const allowed = url.protocol === "http:" || url.protocol === "https:";
  if (!allowed) {
    throw new Error(`provider baseURL must be an HTTP(S) endpoint: ${config.baseURL}`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("remote provider baseURL must use HTTPS");
  }
  if (options.modelBoundary === "managed") {
    const endpointUrl = configuredProviderEndpointUrl(config.baseURL, config.chatEndpointPath);
    if (!isApprovedVeilChatUrl(endpointUrl)) {
      throw new Error("managed runner provider must target an approved Veil chat route");
    }
  }
  return config;
}
