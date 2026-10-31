import type { BackendUiEvent, ReviewFile } from "./types";
import {
  appendTaskEvent as appendSharedTaskEvent,
  appendTaskEvents as appendSharedTaskEvents,
  compactTaskEvents as compactSharedTaskEvents,
  taskEventSignature,
} from "../shared/taskEvents";

// review.ready is a state transition the panel renders on its own, so it is
// kept out of the event feed. Assistant text is never filtered here: this used
// to also drop any answer whose text was exactly "Ready for review.", a
// sentinel no part of the runner or Veil emits any more. Nothing produced it,
// and the only thing it could still match was a model whose real answer
// happened to be that sentence — which then vanished from the transcript, the
// diagnostics, and the UI at once, with no trace anywhere.
export function visibleTaskEvents(events: BackendUiEvent[]): BackendUiEvent[] {
  return events.filter((event) => event.type !== "review.ready");
}

export function appendTaskEvent(events: BackendUiEvent[], event: BackendUiEvent, limit: number): BackendUiEvent[] {
  return appendSharedTaskEvent(visibleTaskEvents(events), event, limit) as BackendUiEvent[];
}

export function appendTaskEvents(events: BackendUiEvent[], batch: readonly BackendUiEvent[], limit: number): BackendUiEvent[] {
  return appendSharedTaskEvents(visibleTaskEvents(events), batch, limit) as BackendUiEvent[];
}

export function compactTaskEvents(events: BackendUiEvent[], limit: number): BackendUiEvent[] {
  return compactSharedTaskEvents(events, limit) as BackendUiEvent[];
}

export function mergeTaskEvents(...groups: BackendUiEvent[][]): BackendUiEvent[] {
  const merged: BackendUiEvent[] = [];
  const mergedCounts = new Map<string, number>();
  for (const group of groups) {
    const groupCounts = new Map<string, number>();
    for (const event of group) {
      const signature = taskEventSignature(event);
      const groupCount = (groupCounts.get(signature) ?? 0) + 1;
      groupCounts.set(signature, groupCount);
      if (groupCount <= (mergedCounts.get(signature) ?? 0)) continue;
      mergedCounts.set(signature, groupCount);
      merged.push(event);
    }
  }
  return compactTaskEvents(merged, 500);
}

export function rendererReviewFiles(files: readonly ReviewFile[]): ReviewFile[] {
  return files.map((file) => file.tooLarge
    ? { ...file, patch: "", hunks: [] }
    : file);
}
