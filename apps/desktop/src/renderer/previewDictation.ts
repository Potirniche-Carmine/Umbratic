/**
 * A scripted dictation for the preview harness.
 *
 * The harness runs in a browser tab with no main process and no microphone, so
 * there is nothing to record and nothing to transcribe. What it can still
 * exercise is the only part of dictation the composer has to get right:
 * partials that replace each other while recording, and a final transcript that
 * lands in the prompt at the cursor.
 */

import type { DictationEvent } from "../shared/desktopApi";

const listeners = new Set<(event: DictationEvent) => void>();
let timers: ReturnType<typeof setTimeout>[] = [];

const partials = ["refactor the auth", "refactor the auth middleware to use"];
const finalText = "refactor the auth middleware to use the new token validation helper";

function emit(event: DictationEvent): void {
  listeners.forEach((send) => send(event));
}

function clearTimers(): void {
  timers.forEach(clearTimeout);
  timers = [];
}

export const previewDictation = {
  start(): { started: boolean } {
    clearTimers();
    timers = partials.map((text, index) =>
      setTimeout(() => emit({ kind: "partial", text }), 700 + index * 900));
    return { started: true };
  },
  stop(): void {
    clearTimers();
    emit({ kind: "final", text: finalText, truncated: false });
  },
  cancel(): void {
    clearTimers();
  },
  subscribe(callback: (event: DictationEvent) => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
