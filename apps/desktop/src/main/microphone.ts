/**
 * Microphone consent, asked for the way a native app asks for it.
 *
 * Chromium's own `getUserMedia` prompt is not what a desktop user expects, and
 * on macOS it does not even reach the system's consent database — an app that
 * never calls `askForMediaAccess` is simply refused, with no dialog and no row
 * in Privacy & Security. So consent is taken here, in the main process, before
 * the renderer touches a capture device: macOS gets its real system prompt, and
 * Windows, which grants per-app access from Settings rather than from a prompt,
 * gets a dialog that offers to open the page that actually decides.
 *
 * The renderer is never told why access failed. A refusal is a thing the user
 * has to fix in system settings, so the explanation belongs in a window that
 * can offer to take them there, not as red text under the prompt box.
 */

import { dialog, shell, systemPreferences } from "electron";

import { getMainWindow } from "./mainRuntime";

/** Where each platform decides whether this app may hear anything. */
const privacySettingsUrl = process.platform === "darwin"
  ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
  : "ms-settings:privacy-microphone";

/**
 * Whether the operating system already allows capture, without asking for it.
 * Used to decide whether pressing the microphone needs a round trip at all.
 */
export function microphoneAccessGranted(): boolean {
  if (process.platform !== "darwin" && process.platform !== "win32") return true;
  return systemPreferences.getMediaAccessStatus("microphone") === "granted";
}

async function explainRefusal(): Promise<void> {
  const window = getMainWindow();
  const options = {
    type: "info" as const,
    title: "Microphone access",
    message: "Umbratic needs access to your microphone to dictate prompts.",
    detail: process.platform === "darwin"
      ? "Turn on Umbratic under Privacy & Security → Microphone, then press the microphone again."
      : "Turn on microphone access for Umbratic in Windows Settings, then press the microphone again.",
    buttons: ["Open Settings", "Not now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response === 0) await shell.openExternal(privacySettingsUrl).catch(() => undefined);
}

/**
 * Takes microphone consent, prompting the way the platform prompts.
 *
 * On macOS an undecided app gets the system's own "Umbratic would like to
 * access the microphone" alert — once, ever, which is why a refusal afterwards
 * is answered with directions rather than another attempt at a prompt the
 * system will no longer show.
 */
export async function requestMicrophoneAccess(): Promise<{ granted: boolean }> {
  if (process.platform !== "darwin" && process.platform !== "win32") return { granted: true };

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return { granted: true };

  if (process.platform === "darwin" && status === "not-determined") {
    const granted = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
    if (granted) return { granted: true };
  }

  await explainRefusal();
  return { granted: false };
}
