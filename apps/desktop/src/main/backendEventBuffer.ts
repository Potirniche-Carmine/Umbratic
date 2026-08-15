import { progressKind, type BackendUiEvent } from "../shared/backendEvents";

const commandOutputLimit = 16_384;
const progressOutputLimit = 24_000;

function boundedStreamText(event: BackendUiEvent, text: string): string {
  if (event.type === "command.output") return text.slice(-commandOutputLimit);
  if (event.type === "assistant.progress.delta") return text.slice(-progressOutputLimit);
  return text;
}

function isStreamingEvent(event: BackendUiEvent): event is Extract<
  BackendUiEvent,
  { type: "assistant.delta" | "assistant.progress.delta" | "command.output" }
> {
  return event.type === "assistant.delta" || event.type === "assistant.progress.delta" || event.type === "command.output";
}

function sameStream(left: BackendUiEvent, right: BackendUiEvent): boolean {
  if (!isStreamingEvent(left) || !isStreamingEvent(right)) return false;
  if (left.type !== right.type || left.taskId !== right.taskId) return false;
  if (left.type === "command.output" && right.type === "command.output") {
    return left.id === right.id && left.stream === right.stream;
  }
  if (left.type === "assistant.progress.delta" && right.type === "assistant.progress.delta") {
    return progressKind(left) === progressKind(right);
  }
  return true;
}

export function appendBufferedBackendEvent(events: BackendUiEvent[], event: BackendUiEvent) {
  const last = events.at(-1);
  if (!last || !sameStream(last, event) || !isStreamingEvent(last) || !isStreamingEvent(event)) {
    events.push(isStreamingEvent(event) ? { ...event, text: boundedStreamText(event, event.text) } as BackendUiEvent : event);
    return;
  }
  events[events.length - 1] = {
    ...last,
    text: boundedStreamText(event, `${last.text}${event.text}`),
    endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
  } as BackendUiEvent;
}

export function shouldBufferBackendEvent(event: BackendUiEvent): boolean {
  return isStreamingEvent(event);
}
