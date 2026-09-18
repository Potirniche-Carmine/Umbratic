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
 * channel file, and the installer it names. The company's update token travels
 * with them, and nothing that tells one machine from another. A user who turns
 * automatic checks off is trusted to mean it: nothing reaches the feed after
 * that, and no button overrides it. An installation holding no token the feed
 * could accept does not ask at all, rather than being refused on a timer for
 * as long as it runs. A development build has no feed and says so.
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

/**
 * How soon to look again after a check that never left the machine. Deciding
 * there is nothing worth sending costs a string comparison and no network, so
 * it can be done often: a device enrolled while the app is running is back on
 * the feed within minutes instead of waiting out the full interval.
 */
const idleRecheckInterval = 10 * 60 * 1000;

/**
 * How old a token may be before this machine stops offering it. The feed
 * refuses one thirty days after it was minted (TOKEN_LIFETIME_SECONDS in
 * infrastructure/downloads-worker/src/worker.js); this is deliberately a day
 * longer. The feed is the only thing that decides who may download, and a
 * local clock running fast must never be able to deny an installation the
 * feed would have served. Erring long costs one refused request. Erring short
 * would strand a licensed machine silently, which is far worse.
 */
const tokenGraceSeconds = 31 * 24 * 60 * 60;

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
 *
 * A refused request is not a failure and does not read as one. It is the feed
 * saying this company is not entitled to releases — because its licence ended,
 * or because it was revoked — which nobody at the keyboard can act on and
 * which nothing here should dress up as a fault.
 */
function failureState(error: unknown): UpdateState {
  const code = (error as { code?: string })?.code ?? "";
  const text = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" && /app-update\.yml/.test(text)) return { phase: "failed", message: "Update settings are missing. Reinstall Umbratic" };
  if (/403/.test(text)) return { phase: "unlicensed" };
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || /404/.test(text)) return { phase: "failed", message: "No release is published for this platform yet" };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR|network/i.test(text)) return { phase: "failed", message: "Could not reach downloads.umbratic.ai" };
  if (/sign|certificate|publisher/i.test(text)) return { phase: "failed", message: "The downloaded release did not verify and was discarded" };
  return { phase: "failed", message: "The update check failed" };
}

/**
 * Enough for the feed to serve the right file, and nothing that would tell one
 * machine from another. The token is the company's, not the device's: the feed
 * serves whoever holds a current one and learns nothing else.
 */
function requestHeaders(token: string): Record<string, string> {
  return {
    "User-Agent": `Umbratic/${app.getVersion()} (${process.platform}; ${process.arch})`,
    "X-Umbratic-Update-Token": token,
  };
}

/**
 * Whether asking the feed could possibly succeed. A machine that has never
 * reached a Veil, or whose company stopped running one a month ago, holds
 * nothing the feed will accept; asking anyway would tell downloads.umbratic.ai
 * that this installation exists, on a timer, for as long as it runs, only to
 * be refused every time.
 *
 * This is not a second copy of the feed's rule and must never become one. It
 * answers no only where no is certain — nothing stored, a token that is not
 * one, or one so old that no clock could make it current — and leaves every
 * judgement call to the Worker, which is the only thing entitled to make it.
 * A token stamped in the future is somebody's clock being wrong, not this
 * machine's business: let the feed answer that.
 */
function worthAsking(token: string): boolean {
  const [orgUID, stamp, signature] = token.split(".");
  if (!orgUID || !stamp || !signature || !/^\d+$/.test(stamp)) return false;
  return Math.floor(Date.now() / 1000) - Number(stamp) <= tokenGraceSeconds;
}

/** Resolves to whether the check actually reached the feed. */
function runCheck(): Promise<boolean> {
  if (checkInFlight) return checkInFlight;
  // Re-read each time: a session opened since the last check will have left a
  // newer token behind, and one that ran out since the last check has not.
  const token = readUpdateFeedTokenSetting();
  if (!worthAsking(token)) {
    // Deliberately not stamping checkedAt: nothing was checked, and a pane
    // reading "checked just now" would be describing a request never sent.
    // Saying it once is enough — this comes round every few minutes, and a
    // renderer woken each time to be told what it already shows is the same
    // pointless chatter as the requests this exists to stop.
    const settled: UpdateState["phase"][] = ["ready", "downloading", "unlicensed"];
    if (!settled.includes(state.phase)) setState({ phase: "unlicensed" });
    return Promise.resolve(false);
  }
  configureUpdater();
  autoUpdater.requestHeaders = requestHeaders(token);
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
    void runCheck().then((reachedFeed) => {
      if (readAutomaticAppUpdatesSetting()) schedule(reachedFeed ? checkInterval : idleRecheckInterval);
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
