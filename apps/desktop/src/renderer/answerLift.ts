import { useEffect, useRef, useState } from "react";

import type { ComposerTimelineItem } from "./rendererTypes";

/// How long the promoted answer restyles in place before Working tucks away.
export const ANSWER_LIFT_MS = 560;

let heldAnswerRect: DOMRect | null = null;

export function rememberHeldAnswerRect(node: HTMLElement | null) {
  if (!node) return;
  heldAnswerRect = node.getBoundingClientRect();
}

export function consumeHeldAnswerRect(): DOMRect | null {
  const rect = heldAnswerRect;
  heldAnswerRect = null;
  return rect;
}

export function heldAnswerText(items: ReadonlyArray<ComposerTimelineItem>): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "activity" || item.finished) continue;
    for (let segmentIndex = item.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = item.segments[segmentIndex];
      if (segment.type === "reasoning" && segment.held) return segment.text.trim();
    }
  }
  return undefined;
}

export function liftedAssistantId(
  previous: ReadonlyArray<ComposerTimelineItem>,
  next: ReadonlyArray<ComposerTimelineItem>,
): string | undefined {
  const held = heldAnswerText(previous);
  if (!held) return undefined;
  const assistant = next.find((item) => item.type === "assistant" && item.text.trim() === held);
  return assistant?.id;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useAnswerLift(items: ComposerTimelineItem[]): {
  liftedAssistantId: string | undefined;
  keepFinishedOpen: boolean;
} {
  const previousRef = useRef(items);
  const liftedIdsRef = useRef(new Set<string>());
  const keepOpenUntilRef = useRef(0);
  const [, bump] = useState(0);
  const detected = liftedAssistantId(previousRef.current, items);
  if (detected) {
    liftedIdsRef.current.add(detected);
    keepOpenUntilRef.current = prefersReducedMotion() ? 0 : Date.now() + ANSWER_LIFT_MS;
  }
  previousRef.current = items;
  const liftedAssistantIdValue = [...liftedIdsRef.current].find((id) => items.some((item) => item.id === id));
  const keepFinishedOpen = Boolean(detected) || Date.now() < keepOpenUntilRef.current;

  useEffect(() => {
    if (!keepFinishedOpen) return undefined;
    const remaining = Math.max(0, keepOpenUntilRef.current - Date.now());
    const timer = window.setTimeout(() => bump((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [keepFinishedOpen, detected]);

  return { liftedAssistantId: liftedAssistantIdValue, keepFinishedOpen };
}
