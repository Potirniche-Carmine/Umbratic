import type { BackendUiEvent } from "../shared/backendEvents";

export type ProviderReconnectState = {
  attempt: number;
  maxAttempts: number;
  /** When the next attempt is due, in epoch ms, when the event said when it was sent. */
  retryAt: number | null;
};

/// The live connection state, read from the reconnect lifecycle rather than
/// inferred from error text.
///
/// A turn that is retrying has not failed: the composer says "wait", not
/// "something is broken". Scanning backwards from the newest event is what
/// keeps the banner honest — anything the turn produced after the drop proves
/// the connection came back, so a stale notice can never outlive its outage
/// even if the reconnected event was missed.
export function providerReconnectFromEvents(
  events: readonly BackendUiEvent[],
): ProviderReconnectState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "provider.reconnecting") {
      const sentAt = event.at ? Date.parse(event.at) : Number.NaN;
      return {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        retryAt: Number.isFinite(sentAt) ? sentAt + event.delayMs : null,
      };
    }
    if (
      event.type === "provider.reconnected"
      || event.type === "assistant.delta"
      || event.type === "assistant.done"
      || event.type === "task.error"
      || event.type === "turn.outcome"
      || event.type === "command.started"
    ) {
      return null;
    }
  }
  return null;
}
