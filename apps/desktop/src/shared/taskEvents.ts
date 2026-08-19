import { progressKind, type BackendUiEvent } from "./backendEvents";
import type { ResponseRating } from "./responseFeedback";

export type TaskUiEvent = BackendUiEvent;
export { isResponseFeedbackReason } from "./responseFeedback";
export type { ResponseRating } from "./responseFeedback";

const REASONING_TEXT_LIMIT = 24_000;
const COMMAND_OUTPUT_TEXT_LIMIT = 16_384;

function eventSignature(event: TaskUiEvent): string {
  if (event.type === "user.message") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
      at: event.at,
      text: event.text,
      attachedFiles: (event.attachedFiles ?? []).map((file) => ({
        path: file.path,
        name: file.name,
        storedPath: file.storedPath,
        originalPath: file.originalPath,
      })),
    });
  }
  if (event.type === "assistant.done") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
    });
  }
  return JSON.stringify(event);
}

function boundedEvents(events: TaskUiEvent[], limit: number): TaskUiEvent[] {
  if (events.length <= limit) return events;
  const recent = events.slice(-limit);
  const retained = events.slice(0, -limit).filter(
    (event) => event.type === "user.message" || event.type === "assistant.delta" || event.type === "assistant.done"
      || event.type === "response.feedback" || event.type === "tool.failed" || event.type === "context.threshold",
  );
  return [...retained, ...recent];
}

export function toggleResponseRating(
  current: ResponseRating | undefined,
  selected: ResponseRating,
): ResponseRating | null {
  return current === selected ? null : selected;
}

export function removeResponseFeedback(
  events: TaskUiEvent[],
  taskId: string,
  messageId: string,
): TaskUiEvent[] {
  return events.filter(
    (event) => !(event.type === "response.feedback"
      && event.taskId === taskId
      && event.messageId === messageId),
  );
}

/// Fold one event into an array being built, in place. Returns whether it
/// changed anything, so a batch that was entirely duplicates can hand back the
/// caller's own array and let React skip the render.
function mergeTaskEvent(events: TaskUiEvent[], nextEvent: TaskUiEvent): boolean {
  if (nextEvent.type === "response.feedback") {
    const taskId = nextEvent.taskId;
    const messageId = nextEvent.messageId;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const stored = events[index];
      if (stored.type === "response.feedback" && stored.taskId === taskId && stored.messageId === messageId) {
        events.splice(index, 1);
      }
    }
    events.push(nextEvent);
    return true;
  }
  if (
    nextEvent.type === "user.message"
    && nextEvent.at
    && events.some(
      (storedEvent) =>
        storedEvent.type === "user.message"
        && storedEvent.at === nextEvent.at
        && eventSignature(storedEvent) === eventSignature(nextEvent),
    )
  ) {
    return false;
  }
  const last = events.at(-1);
  if (
    last
    && (nextEvent.type === "assistant.delta" || nextEvent.type === "assistant.progress.delta")
    && last.type === nextEvent.type
    && last.taskId === nextEvent.taskId
    && (nextEvent.type !== "assistant.progress.delta" || progressKind(last) === progressKind(nextEvent))
  ) {
    events[events.length - 1] = {
      ...last,
      text: nextEvent.type === "assistant.progress.delta"
        ? `${last.text}${nextEvent.text}`.slice(-REASONING_TEXT_LIMIT)
        : `${last.text}${nextEvent.text}`,
      endedAt: nextEvent.endedAt ?? nextEvent.at ?? last.endedAt ?? last.at,
    };
    return true;
  }
  if (
    last
    && nextEvent.type === "command.output"
    && last.type === "command.output"
    && last.taskId === nextEvent.taskId
    && last.id === nextEvent.id
    && last.stream === nextEvent.stream
  ) {
    events[events.length - 1] = {
      ...last,
      text: `${last.text}${nextEvent.text}`.slice(-COMMAND_OUTPUT_TEXT_LIMIT),
      endedAt: nextEvent.endedAt ?? nextEvent.at ?? last.endedAt ?? last.at,
    };
    return true;
  }
  events.push(
    nextEvent.type === "assistant.progress.delta"
      ? { ...nextEvent, text: nextEvent.text.slice(-REASONING_TEXT_LIMIT) }
      : nextEvent.type === "command.output"
        ? { ...nextEvent, text: nextEvent.text.slice(-COMMAND_OUTPUT_TEXT_LIMIT) }
        : nextEvent,
  );
  return true;
}

/// Fold a whole batch in with one copy of the array.
///
/// The transcript is appended to about twenty times a second while a run
/// streams, and every one of those appends used to rebuild the array — and, in
/// the event cache, replay the entire history through this function to rebuild
/// it. That is quadratic in the length of the chat, and it is allocation, not
/// arithmetic: a long chat spent its time in the collector, which is what made
/// scrolling stutter and the renderer's memory climb. One copy per batch keeps
/// the result identical and the cost linear.
export function appendTaskEvents(
  events: TaskUiEvent[],
  incoming: readonly TaskUiEvent[],
  limit = 500,
): TaskUiEvent[] {
  if (!incoming.length) return events;
  const next = events.slice();
  let changed = false;
  for (const event of incoming) {
    if (mergeTaskEvent(next, event)) changed = true;
  }
  if (!changed) return events;
  return boundedEvents(next, limit);
}

export function appendTaskEvent(events: TaskUiEvent[], event: TaskUiEvent, limit = 500): TaskUiEvent[] {
  return appendTaskEvents(events, [event], limit);
}

export function compactTaskEvents(events: TaskUiEvent[], limit = 500): TaskUiEvent[] {
  return appendTaskEvents([], events, limit);
}

export { eventSignature as taskEventSignature };
