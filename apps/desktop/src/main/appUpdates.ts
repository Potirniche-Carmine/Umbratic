/**
 * Keeping the installed app current from downloads.umbratic.ai.
 *
 * The feed is the one electron-builder wrote next to the installers and
 * `scripts/publish-release.ts` uploaded: a channel file naming the newest
 * release, and the release itself. electron-updater reads the channel file,
 * downloads the installer in the background, checks its signature — Squirrel
 * refuses an app not signed by the same Team ID, and the Windows updater
 * verifies the installer's publisher — and swaps it in on the next quit.
 * Nothing here decides what a release contains; this module only decides
 * when to look, and tells the renderer what it found.
 *
 * What reaches the network is exactly two requests, both to the one host: the
 * channel file, and the installer it names. No identifier travels with either.
 * A user who turns automatic checks off is trusted to mean it: after that only
 * "Check now" reaches the feed. A development build has no feed and says so.
 */

import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateStatus } from "../shared/desktopApi";
import { recordLocalDiagnostic } from "./diagnostics";
import { readAutomaticAppUpdatesSetting, readUpdateFeedTokenSetting, writeAutomaticAppUpdatesSetting } from "./storage";

type UpdateState = AppUpdateStatus["state"];

/** How often a running app looks, and how long after launch it first does. */
const checkInterval = 6 * 60 * 60 * 1000;
const firstCheckDelay = 45 * 1000;

let state: UpdateState = app.isPackaged ? { phase: "idle" } : { phase: "unsupported" };
let checkedAt: string | null = null;
let listener: ((status: AppUpdateStatus) => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let configured = false;
let checkInFlight: Promise<void> | null = null;

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
  autoUpdater.requestHeaders = requestHeaders();
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
    setState({ phase: "failed", message: failureMessage(error) });
  });
}

/**
 * The failure the user sees. electron-updater's messages name URLs, status
 * codes and stack frames; the person reading the settings pane needs to know
 * whether the feed was unreachable or something else went wrong. No trailing
 * period: the pane appends when it was checked and closes the sentence.
 */
function failureMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? "";
  const text = error instanceof Error ? error.message : String(error);
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || /404/.test(text)) return "No release is published for this platform yet";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR|network/i.test(text)) return "Could not reach downloads.umbratic.ai";
  if (/403/.test(text)) return "This installation is not licensed for updates";
  if (/sign|certificate|publisher/i.test(text)) return "The downloaded release did not verify and was discarded";
  return "The update check failed";
}

/**
 * Enough for the feed to serve the right file, and nothing that would tell one
 * machine from another. The token is the company's, not the device's: the feed
 * serves whoever holds a current one and learns nothing else.
 */
function requestHeaders(): Record<string, string> {
  return {
    "User-Agent": `Umbratic/${app.getVersion()} (${process.platform}; ${process.arch})`,
    "X-Umbratic-Update-Token": readUpdateFeedTokenSetting(),
  };
}

function runCheck(): Promise<void> {
  if (checkInFlight) return checkInFlight;
  configureUpdater();
  // Re-read each time: a session opened since the last check will have left a
  // newer token behind.
  autoUpdater.requestHeaders = requestHeaders();
  checkInFlight = autoUpdater.checkForUpdates()
    .then(() => undefined)
    .catch((error: unknown) => {
      // The "error" event above has already described it to the renderer;
      // this only keeps the rejection from surfacing as unhandled.
      recordLocalDiagnostic({ level: "warn", source: "updates", event: "updater.check.failed", message: error instanceof Error ? error.message : String(error) });
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

/** "Check now": consults the feed and answers once the check has resolved. */
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
