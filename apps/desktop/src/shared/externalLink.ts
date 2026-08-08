/**
 * Which URLs a link in model output is allowed to open.
 *
 * Links reach the timeline from model output, which is untrusted text, so the
 * href is treated as hostile input rather than as a destination. Only schemes
 * that mean "show this to the user in their browser" are allowed: `javascript:`
 * executes, `file:` and `blob:` reach local content, and `data:` can carry a
 * whole document, none of which a chat reply gets to trigger.
 *
 * Both sides check. The renderer checks so an unsafe URL never becomes a
 * clickable anchor, and the main process checks again because a compromised
 * renderer could invoke the channel directly — the renderer's check is a UI
 * decision, the main process's is the actual boundary.
 */
const allowedProtocols = new Set(["http:", "https:", "mailto:"]);

const maxUrlLength = 2048;

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > maxUrlLength) return null;
  // Whitespace and control characters inside the scheme are the classic way to
  // smuggle one past a check that only looks at the start of the string —
  // "java\tscript:alert(1)" is parsed as javascript: by some consumers.
  if (/[\u0000-\u0020\u007f]/.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // Relative and malformed URLs land here. There is nothing to open.
    return null;
  }
  if (!allowedProtocols.has(parsed.protocol)) return null;
  return parsed.toString();
}

/** A short, honest label for a URL shown as a link's title. */
export function externalUrlTitle(url: string): string {
  return url.length > 120 ? `${url.slice(0, 119)}…` : url;
}
