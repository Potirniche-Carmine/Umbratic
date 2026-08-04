import type { BackendUiEvent } from "./backendEvents";
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

export function appendTaskEvent(events: TaskUiEvent[], event: TaskUiEvent, limit = 500): TaskUiEvent[] {
  const nextEvent = event;
  const existing = events;
  if (nextEvent.type === "response.feedback") {
    return boundedEvents([
      ...removeResponseFeedback(existing, nextEvent.taskId, nextEvent.messageId),
      nextEvent,
    ], limit);
  }
  if (
    nextEvent.type === "user.message"
    && nextEvent.at
    && existing.some(
      (storedEvent) =>
        storedEvent.type === "user.message"
        && storedEvent.at === nextEvent.at
        && eventSignature(storedEvent) === eventSignature(nextEvent),
    )
  ) {
    return existing;
  }
  const last = existing.at(-1);
  if (
    last
    && nextEvent.type === "user.message"
    && last.type === "user.message"
    && nextEvent.at
    && last.at === nextEvent.at
    && eventSignature(last) === eventSignature(nextEvent)
  ) {
    return existing;
  }
  if (
    last
    && (nextEvent.type === "assistant.delta" || nextEvent.type === "assistant.progress.delta")
    && last.type === nextEvent.type
    && last.taskId === nextEvent.taskId
  ) {
    return boundedEvents([
      ...existing.slice(0, -1),
      {
        ...last,
        text: nextEvent.type === "assistant.progress.delta"
          ? `${last.text}${nextEvent.text}`.slice(-REASONING_TEXT_LIMIT)
          : `${last.text}${nextEvent.text}`,
        endedAt: nextEvent.endedAt ?? nextEvent.at ?? last.endedAt ?? last.at,
      },
    ], limit);
  }
  if (
    last
    && nextEvent.type === "command.output"
    && last.type === "command.output"
    && last.taskId === nextEvent.taskId
    && last.id === nextEvent.id
    && last.stream === nextEvent.stream
  ) {
    return boundedEvents([
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${nextEvent.text}`.slice(-COMMAND_OUTPUT_TEXT_LIMIT),
        endedAt: nextEvent.endedAt ?? nextEvent.at ?? last.endedAt ?? last.at,
      },
    ], limit);
  }
  const boundedEvent = nextEvent.type === "assistant.progress.delta"
    ? { ...nextEvent, text: nextEvent.text.slice(-REASONING_TEXT_LIMIT) }
    : nextEvent.type === "command.output"
      ? { ...nextEvent, text: nextEvent.text.slice(-COMMAND_OUTPUT_TEXT_LIMIT) }
      : nextEvent;
  return boundedEvents([...existing, boundedEvent], limit);
}

export function compactTaskEvents(events: TaskUiEvent[], limit = 500): TaskUiEvent[] {
  return events.reduce<TaskUiEvent[]>((current, event) => appendTaskEvent(current, event, limit), []);
}

export { eventSignature as taskEventSignature };
