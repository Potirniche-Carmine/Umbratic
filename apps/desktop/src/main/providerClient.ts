import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";

import type { EndpointMtlsConfig } from "./config";

function assertSecureEndpoint(url: URL) {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote model endpoints must use HTTPS.");
  }
}

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

function tlsOptions(url: URL, mtls?: EndpointMtlsConfig): https.RequestOptions {
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

export async function getProviderJson(
  rawUrl: string,
  options: { headers?: Record<string, string>; mtls?: EndpointMtlsConfig; signal?: AbortSignal } = {},
): Promise<{ statusCode: number; statusMessage: string; text: string; json: unknown | null }> {
  return requestProviderJson(rawUrl, { method: "GET", headers: options.headers, mtls: options.mtls, signal: options.signal });
}

export async function postProviderJson(
  rawUrl: string,
  body: unknown,
  options: { headers?: Record<string, string>; mtls?: EndpointMtlsConfig; signal?: AbortSignal } = {},
): Promise<{ statusCode: number; statusMessage: string; text: string; json: unknown | null }> {
  return requestProviderJson(rawUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(body),
    mtls: options.mtls,
    signal: options.signal,
  });
}

async function requestProviderJson(
  rawUrl: string,
  options: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; mtls?: EndpointMtlsConfig; signal?: AbortSignal },
): Promise<{ statusCode: number; statusMessage: string; text: string; json: unknown | null }> {
  const url = new URL(rawUrl);
  assertSecureEndpoint(url);
  const requestOptions: http.RequestOptions | https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers: {
      ...(options.headers ?? {}),
      ...(options.body ? { "Content-Length": Buffer.byteLength(options.body).toString() } : {}),
    },
    ...(url.protocol === "https:" ? tlsOptions(url, options.mtls) : {}),
  };
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown | null = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({
          statusCode: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? "",
          text,
          json,
        });
      });
    });
    const abort = () => {
      request.destroy(new Error("Request aborted."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => options.signal?.removeEventListener("abort", abort));
    request.end(options.body);
  });
}
