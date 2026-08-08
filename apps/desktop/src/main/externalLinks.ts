import { shell } from "electron";

import { safeExternalUrl } from "../shared/externalLink";

/**
 * Opens a link from a chat reply in the user's browser.
 *
 * The renderer already refuses to make an unsafe URL clickable, but that is a
 * display decision taken over untrusted model output. This is the boundary: the
 * scheme is checked again here, against the same allowlist, before anything is
 * handed to the operating system. A renderer that has been compromised can
 * invoke this channel directly, and the answer must still be no.
 */
export async function openExternalLink(url: unknown): Promise<{ ok: boolean }> {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return { ok: false };
  try {
    await shell.openExternal(safeUrl);
    return { ok: true };
  } catch {
    // A failed hand-off to the OS is the user's problem to see in the browser,
    // not an error worth crashing an IPC call over.
    return { ok: false };
  }
}
