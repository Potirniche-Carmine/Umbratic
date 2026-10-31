import { useSyncExternalStore } from "react";

/**
 * How diffs are drawn, held in one place for everyone who draws or changes it.
 *
 * The review panel and General settings offer the same two choices, and each
 * used to keep its own `useState` copy seeded from `localStorage` at mount.
 * Both are mounted at once — the panel lives in the shell whether or not it is
 * showing — so a choice made in settings never reached the panel and a choice
 * made in the panel never reached settings. Whichever was read first won, and
 * the settings rows looked like they did nothing.
 *
 * One store, subscribed to rather than sampled, so a change made anywhere is
 * the change everywhere. `localStorage` stays the durable copy; a store that
 * refuses to write (a locked profile) still keeps the value for the session.
 */

export const reviewViewModeKey = "umbratic-review-view-mode";
export const reviewWrapKey = "umbratic-review-wrap";

export type ReviewLayout = "split" | "unified";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Cached rather than read on every render: `useSyncExternalStore` calls the
// snapshot during render and compares by identity, so the answer has to be
// both cheap and stable between notifications.
let layout: ReviewLayout = readStored(reviewViewModeKey) === "unified" ? "unified" : "split";
// Wrapped lines are the readable default. An explicit opt-out from a prior
// session survives; nothing else starts a review scrolling sideways.
let wrap: boolean = readStored(reviewWrapKey) !== "false";

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* A blocked store keeps the session value only. */
  }
}

export function setReviewLayout(next: ReviewLayout): void {
  if (layout === next) return;
  layout = next;
  persist(reviewViewModeKey, next);
  notify();
}

export function setReviewWrap(next: boolean): void {
  if (wrap === next) return;
  wrap = next;
  persist(reviewWrapKey, String(next));
  notify();
}

export function useReviewLayout(): ReviewLayout {
  return useSyncExternalStore(subscribe, () => layout, () => layout);
}

export function useReviewWrap(): boolean {
  return useSyncExternalStore(subscribe, () => wrap, () => wrap);
}
