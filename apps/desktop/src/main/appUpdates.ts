/** Public GitHub releases supply update metadata and signed installers.
 * Downloads remain subject to Electron's platform signature verification.
 */

import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateStatus } from "../shared/desktopApi";
import { recordLocalDiagnostic } from "./diagnostics";
import { readAutomaticAppUpdatesSetting, writeAutomaticAppUpdatesSetting } from "./storage";

type UpdateState = AppUpdateStatus["state"];

/** How often a running app looks, and how long after launch it first does. */
const checkInterval = 6 * 60 * 60 * 1000;
const firstCheckDelay = 45 * 1000;

let state: UpdateState = app.isPackaged ? { phase: "idle" } : { phase: "unsupported" };
let checkedAt: string | null = null;
let listener: ((status: AppUpdateStatus) => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let configured = false;
let checkInFlight: Promise<boolean> | null = null;

export function appUpdateStatus(): AppUpdateStatus {
  return {
    installedVersion: app.getVersion(),
    automatic: readAutomaticAppUpdatesSetting(),
    checkedAt,
    state,
  };
}

/** The renderer's view of every change, including download progress. */
export function onAppUpdateStatus(callback: (status: AppUpdateStatus) => void): void {
  listener = callback;
}

function setState(next: UpdateState) {
  state = next;
  listener?.(appUpdateStatus());
}

function configureUpdater() {
  if (configured) return;
  configured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  // A release feed only ever moves forward, and an app that could be talked
  // into an older build by a feed would have a security problem, not a
  // feature. The channel setter below flips this on, so it is set after.
  if (process.platform === "win32" && process.arch !== "x64") {
    // Windows x64 and arm64 are separate builds with their own channel files,
    // so an arm64 machine with no arm64 release yet sees nothing rather than
    // the x64 installer. macOS is arm64 only and keeps the default name.
    autoUpdater.channel = `latest-${process.arch}`;
  }
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (message: unknown) => recordLocalDiagnostic({ level: "warn", source: "updates", event: "updater.warning", message: String(message) }),
    error: (message: unknown) => recordLocalDiagnostic({ level: "error", source: "updates", event: "updater.error", message: String(message) }),
  };

  autoUpdater.on("checking-for-update", () => setState({ phase: "checking" }));
  autoUpdater.on("update-not-available", () => {
    checkedAt = new Date().toISOString();
    setState({ phase: "current" });
  });
  autoUpdater.on("update-available", (info) => {
    checkedAt = new Date().toISOString();
    setState({ phase: "downloading", latestVersion: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    if (state.phase !== "downloading") return;
    setState({ ...state, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
  });
  autoUpdater.on("update-downloaded", (info) => setState({ phase: "ready", latestVersion: info.version }));
  autoUpdater.on("error", (error) => {
    // A downloaded release stays ready through a later failed check; the
    // failure only replaces a check or download that was in progress.
    if (state.phase === "ready") return;
    checkedAt = new Date().toISOString();
    setState(failureState(error));
  });
}

/**
 * What the user sees when a check does not come back with a release.
 * electron-updater's messages name URLs, status codes and stack frames; the
 * person reading the settings pane needs to know whether the feed was
 * unreachable or something else went wrong. No trailing period: the pane
 * appends when it was checked.
 */
function failureState(error: unknown): UpdateState {
  const code = (error as { code?: string })?.code ?? "";
  const text = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" && /app-update\.yml/.test(text)) return { phase: "failed", message: "Update settings are missing. Reinstall Umbratic" };
  if (/403|429/.test(text)) return { phase: "failed", message: "GitHub is limiting update requests. Try again later" };
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || /404/.test(text)) return { phase: "failed", message: "No release is published for this platform yet" };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR|network/i.test(text)) return { phase: "failed", message: "Could not reach GitHub releases" };
  if (/sign|certificate|publisher/i.test(text)) return { phase: "failed", message: "The downloaded release did not verify and was discarded" };
  return { phase: "failed", message: "The update check failed" };
}

/** Concurrent callers share one update request. */
function runCheck(): Promise<boolean> {
  if (checkInFlight) return checkInFlight;
  configureUpdater();
  autoUpdater.requestHeaders = { "User-Agent": `Umbratic/${app.getVersion()} (${process.platform}; ${process.arch})` };
  checkInFlight = autoUpdater.checkForUpdates()
    .then(() => true)
    .catch((error: unknown) => {
      // The "error" event above has already described it to the renderer;
      // this only keeps the rejection from surfacing as unhandled.
      recordLocalDiagnostic({ level: "warn", source: "updates", event: "updater.check.failed", message: error instanceof Error ? error.message : String(error) });
      return true;
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runCheck().then(() => {
      if (readAutomaticAppUpdatesSetting()) schedule(checkInterval);
    });
  }, delay);
  timer.unref?.();
}

/**
 * Begins the background rhythm, if the app is packaged and the user has not
 * turned it off. Called once the window is up: the first check waits a little
 * so launch is spent on the user's work, not ours.
 */
export function startAppUpdates(): void {
  if (!app.isPackaged) return;
  if (readAutomaticAppUpdatesSetting()) schedule(firstCheckDelay);
}

export function stopAppUpdates(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Runs one check and answers once it has resolved. The background rhythm is
 * the only caller in the product: no IPC channel reaches this, so nothing the
 * renderer can do makes the app talk to the feed. Kept exported because it is
 * this module's one way in, and the tests drive it.
 */
export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  if (app.isPackaged) await runCheck();
  return appUpdateStatus();
}

export function setAutomaticAppUpdates(enabled: unknown): AppUpdateStatus {
  const automatic = writeAutomaticAppUpdatesSetting(enabled === true);
  if (app.isPackaged) {
    if (automatic) schedule(firstCheckDelay);
    else stopAppUpdates();
  }
  return appUpdateStatus();
}

/** Restart into the downloaded release. A no-op unless one is ready. */
export function installAppUpdate(): void {
  if (state.phase !== "ready") return;
  autoUpdater.quitAndInstall();
}
