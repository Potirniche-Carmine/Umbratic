/**
 * Whether a renderer URL is allowed to talk to the main process or to load as
 * the app frame. The check is origin-only in development (Vite on loopback)
 * and an exact file URL in a packaged build, so a random page cannot invoke IPC
 * even if it somehow shares a session.
 */
export function trustedRendererUrl(
  rawUrl: string,
  options: { isDev: boolean; trustedDevOrigin: URL; packagedIndexHref: string },
): boolean {
  try {
    const url = new URL(rawUrl);
    if (options.isDev) {
      const trusted = options.trustedDevOrigin;
      return (
        url.protocol === trusted.protocol &&
        url.hostname === trusted.hostname &&
        url.port === trusted.port
      );
    }
    return url.href === options.packagedIndexHref;
  } catch {
    return false;
  }
}
