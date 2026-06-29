import * as fs from "node:fs";
import * as path from "node:path";

import type { EndpointMtlsConfig } from "./config";
import { postProviderJson } from "./providerClient";
import {
  listTelemetrySpoolFiles,
  type RedactedTelemetryBundle,
  writeTelemetrySpoolFile,
} from "./telemetry";
import type { TelemetrySyncResult } from "./types";

export type TelemetryUploadEndpoint = {
  url: string;
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
};

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function telemetrySpoolDirectory(userDataPath: string): string {
  return path.join(userDataPath, "telemetry-spool");
}

export async function uploadTelemetrySpool(input: {
  directory: string;
  endpoint: TelemetryUploadEndpoint;
  timeoutMs?: number;
}): Promise<{ uploaded: number; pending: number; lastError?: string }> {
  const files = await listTelemetrySpoolFiles(input.directory);
  let uploaded = 0;
  let lastError: string | undefined;
  for (const filePath of files) {
    let body: unknown;
    try {
      body = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    } catch (cause) {
      lastError = `Could not read telemetry spool file: ${safeMessage(cause)}`;
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
    try {
      const response = await postProviderJson(input.endpoint.url, body, {
        headers: { Accept: "application/json", ...(input.endpoint.headers ?? {}) },
        mtls: input.endpoint.mtls,
        signal: controller.signal,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const detail = response.text.trim().slice(0, 180);
        lastError = `Telemetry upload failed with ${response.statusCode} ${response.statusMessage}${detail ? `: ${detail}` : ""}`;
        break;
      }
      await fs.promises.unlink(filePath);
      uploaded += 1;
    } catch (cause) {
      lastError = `Telemetry upload failed: ${safeMessage(cause)}`;
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  const pending = (await listTelemetrySpoolFiles(input.directory)).length;
  return { uploaded, pending, lastError };
}

export async function syncTelemetryBundle(input: {
  directory: string;
  bundle: RedactedTelemetryBundle;
  endpoint: TelemetryUploadEndpoint;
  date?: Date;
}): Promise<TelemetrySyncResult> {
  const spooledPath = await writeTelemetrySpoolFile(input.directory, input.bundle, input.date);
  const upload = await uploadTelemetrySpool({ directory: input.directory, endpoint: input.endpoint });
  const ok = !upload.lastError;
  return {
    ok,
    uploaded: upload.uploaded,
    pending: upload.pending,
    spooledPath,
    spoolDirectory: input.directory,
    destination: input.endpoint.url,
    message: ok
      ? `Uploaded ${upload.uploaded} telemetry bundle${upload.uploaded === 1 ? "" : "s"}.`
      : `${upload.lastError}. Redacted telemetry is spooled for retry.`,
  };
}
