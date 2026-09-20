import { app } from "electron";
import { recordLocalDiagnostic } from "./diagnostics";
import { endpointProvider } from "./endpointConfig";
import { telemetryUploadEndpoint } from "./modelEndpointRuntime";
import { telemetryPolicyForMode } from "./policy";
import { readModelEndpointSettings, readTasks, readProjects, readProductTelemetryEvents, readLocalDiagnostics } from "./storage";
import { buildRedactedTelemetryBundle } from "./telemetry";
import { syncTelemetryBundle, telemetrySpoolDirectory, uploadTelemetrySpool } from "./telemetrySync";
import type { TelemetrySyncResult } from "./types";

let telemetrySyncTimer: NodeJS.Timeout | null = null;

export async function retryTelemetrySpoolQueue(): Promise<void> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) return;
  const provider = endpointProvider();
  await uploadTelemetrySpool({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    endpoint: telemetryUploadEndpoint(provider),
  });
}

export async function syncTelemetryNow(): Promise<TelemetrySyncResult> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) {
    throw new Error("Telemetry sync is disabled by policy.");
  }
  const provider = endpointProvider();
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects(), readProductTelemetryEvents(), readLocalDiagnostics());
  return syncTelemetryBundle({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    bundle,
    endpoint: telemetryUploadEndpoint(provider),
  });
}

export function scheduleManagedTelemetrySync() {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled || telemetrySyncTimer) return;
  telemetrySyncTimer = setTimeout(() => {
    telemetrySyncTimer = null;
    void syncTelemetryNow().catch((cause) => {
      recordLocalDiagnostic({
        level: "warn",
        source: "telemetry",
        event: "sync.failed",
        message: String(cause instanceof Error ? cause.message : cause),
      });
    });
  }, 5000);
  telemetrySyncTimer.unref?.();
}
