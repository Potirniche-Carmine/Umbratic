import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";

import type { UmbraticProviderMtlsConfig } from "./local.js";

type RequestOptions = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  mtls?: UmbraticProviderMtlsConfig;
  signal?: AbortSignal;
};

export type ModelHttpResponse = {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
};

function readOptionalFile(filePath?: string): Buffer | undefined {
  if (!filePath) return undefined;
  return fs.readFileSync(filePath);
}

function normalizeSha256Fingerprint(value: string): string {
  return value.replace(/^sha256[:/]/i, "").replace(/[^A-Fa-f0-9]/g, "").toLowerCase();
}

function certificateSha256(cert: tls.PeerCertificate): string {
  const raw = Buffer.isBuffer(cert.raw) ? cert.raw : Buffer.from(cert.raw);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function tlsOptions(url: URL, mtls?: UmbraticProviderMtlsConfig): https.RequestOptions {
  if (!mtls) return {};
  const pinned = mtls.pinnedServerCertificateSha256?.trim();
  const options: https.RequestOptions = {
    ca: readOptionalFile(mtls.caPath),
    cert: readOptionalFile(mtls.certPath),
    key: readOptionalFile(mtls.keyPath),
    pfx: readOptionalFile(mtls.pfxPath),
    passphrase: mtls.passphrase,
    servername: mtls.serverName || url.hostname,
    minVersion: "TLSv1.2",
  };
  if (pinned) {
    options.checkServerIdentity = (hostname, cert) => {
      const defaultError = tls.checkServerIdentity(hostname, cert);
      if (defaultError) return defaultError;
      const expected = normalizeSha256Fingerprint(pinned);
      const actual = certificateSha256(cert);
      if (actual !== expected) {
        return new Error(`Pinned server certificate mismatch for ${hostname}.`);
      }
      return undefined;
    };
  }
  return options;
}

export async function modelHttpRequest(rawUrl: string, options: RequestOptions): Promise<ModelHttpResponse> {
  const url = new URL(rawUrl);
  const body = options.body ?? "";
  const headers = {
    ...(options.headers ?? {}),
    ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
  };
  const requestOptions: http.RequestOptions | https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers,
    ...(url.protocol === "https:" ? tlsOptions(url, options.mtls) : {}),
  };
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? "",
        headers: response.headers,
        body: response,
      });
    });
    const abort = () => {
      request.destroy(new Error("Request aborted."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => options.signal?.removeEventListener("abort", abort));
    if (body) request.write(body);
    request.end();
  });
}

export async function readBodyText(stream: AsyncIterable<Buffer | string>, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      chunks.push(buffer.subarray(0, Math.max(0, buffer.length - (total - limit))));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
