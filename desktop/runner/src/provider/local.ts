export type UmbraticProviderConfig = {
  id: "company-endpoint";
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
  const allowed = url.protocol === "http:" || url.protocol === "https:";
  if (!allowed) {
    throw new Error(`provider baseURL must be an HTTP(S) endpoint: ${config.baseURL}`);
  }
  return config;
}
