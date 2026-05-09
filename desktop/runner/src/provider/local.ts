export type AegisProviderConfig = {
  id: "local-endpoint" | "company-model";
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
};

export function assertAllowedProvider(config: AegisProviderConfig): AegisProviderConfig {
  const url = new URL(config.baseURL);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed =
    (url.protocol === "http:" || url.protocol === "https:") &&
    (hostname === "localhost" ||
      hostname === "::1" ||
      hostname.startsWith("127.") ||
      /^ai\.[a-z0-9.-]+\.internal$/.test(hostname));
  if (!allowed) {
    throw new Error(`provider baseURL not on the Aegis allowlist: ${config.baseURL}`);
  }
  return config;
}
