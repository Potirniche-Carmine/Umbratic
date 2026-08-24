import { useEffect, useRef, useState } from "react";

import type { ComposerTimelineItem } from "./rendererTypes";

/// How long a just-finished Working block stays open before tucking away.
///
/// The block finishing and the answer's first tokens land in the same flush,
/// so a collapse on that frame reads as part of one confusing burst. A beat of
/// stillness first lets the reader see the work settle, then the tuck is the
/// only thing moving.
export const ACTIVITY_TUCK_DELAY_MS = 1000;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/// True while a Working block that just finished should stay open.
///
/// Reduced motion skips the delay: with the collapse transition already near
/// instant, holding the block open first would only postpone the settled page.
export function useActivityTuckDelay(items: ComposerTimelineItem[]): boolean {
  const unfinishedIdsRef = useRef<Set<string>>(new Set());
  const keepOpenUntilRef = useRef(0);
  const [, bump] = useState(0);

  const nowUnfinished = new Set<string>();
  let justFinished = false;
  for (const item of items) {
    if (item.type !== "activity") continue;
    if (!item.finished) nowUnfinished.add(item.id);
    else if (unfinishedIdsRef.current.has(item.id)) justFinished = true;
  }
  unfinishedIdsRef.current = nowUnfinished;
  if (justFinished && !prefersReducedMotion()) {
    keepOpenUntilRef.current = Date.now() + ACTIVITY_TUCK_DELAY_MS;
  }
  const keepFinishedOpen = Date.now() < keepOpenUntilRef.current;

  useEffect(() => {
    if (!keepFinishedOpen) return undefined;
    const remaining = Math.max(0, keepOpenUntilRef.current - Date.now());
    const timer = window.setTimeout(() => bump((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [keepFinishedOpen, items]);

  return keepFinishedOpen;
}
