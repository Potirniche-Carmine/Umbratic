import { recordLocalDiagnostic } from "./diagnostics";
import { ensureLocalVeil } from "./localVeil";
import { readContextLengthSetting, readModelEndpointSettings } from "./storage";

/**
 * Start the managed local model and load it into memory without waiting for a
 * chat request. Server-mode runtimes own their model lifecycle.
 */
export async function warmConfiguredModel(): Promise<void> {
  try {
    const settings = readModelEndpointSettings();
    if (settings.mode !== "local") return;
    await ensureLocalVeil(settings, readContextLengthSetting(), (diagnostic) => {
      recordLocalDiagnostic({
        ...diagnostic,
        source: "veil",
      });
    });
  } catch (cause) {
    recordLocalDiagnostic({
      level: "warn",
      source: "desktop",
      event: "startup.model_warmup.failed",
      message: String(cause instanceof Error ? cause.message : cause),
    });
  }
}

export async function loadWindowWithModelWarmup(
  loadWindow: () => Promise<void>,
  warmModel: () => Promise<void> = warmConfiguredModel,
): Promise<void> {
  const windowReady = loadWindow();
  void warmModel().catch(() => undefined);
  await windowReady;
}
