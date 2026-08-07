import type { BackendUiEvent } from "../shared/backendEvents";

export type ProviderReconnectState = {
  attempt: number;
  maxAttempts: number;
  /// When this outage started, not when the current attempt did. Over a
  /// multi-minute retry window an attempt counter alone says nothing about how
  /// long the user has been waiting, which is the thing they are actually
  /// judging when they decide whether to give up and press Stop.
  since?: string;
};

/// How long the outage has lasted, in the coarsest honest unit.
///
/// Seconds below a minute, then whole minutes: a reconnect banner is glanced
/// at, not read, and a ticking seconds counter past the first minute is noise
/// that draws the eye without informing it.
export function reconnectElapsedLabel(since: string | undefined, now: number): string {
  if (!since) return "";
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

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
      // Walk back over the run of attempts to find where this outage began.
      let first = event;
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const candidate = events[earlier];
        if (candidate.type !== "provider.reconnecting") break;
        first = candidate;
      }
      return {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        ...(first.at ? { since: first.at } : {}),
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
