export type UmbraticProviderConfig = {
  id: "company-endpoint" | "company-model";
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
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

export function assertAllowedProvider(config: UmbraticProviderConfig): UmbraticProviderConfig {
  const url = new URL(config.baseURL);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed =
    (url.protocol === "http:" || url.protocol === "https:") &&
    (hostname === "localhost" ||
      hostname === "::1" ||
      hostname.startsWith("127.") ||
      /^ai\.[a-z0-9.-]+\.internal$/.test(hostname));
  if (!allowed) {
    throw new Error(`provider baseURL not on the Umbratic AI allowlist: ${config.baseURL}`);
  }
  return config;
}
