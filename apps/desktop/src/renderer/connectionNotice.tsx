import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ProviderReconnectState } from "./connectionStatus";

/** Whole seconds until the next attempt, never below zero. */
export function secondsUntil(retryAt: number | null, now: number): number | null {
  if (retryAt === null) return null;
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * The turn is waiting on a server it cannot reach. A pill laid over the prompt
 * box's corner, not a bar in the layout: it appears without moving the box or
 * the conversation, and it names the wait — the count of visible retries and
 * the seconds until the next one — so a frozen composer reads as "waiting"
 * rather than "broken". The retries the runner made silently before
 * this are not in the count; they were over before a notice could be read.
 */
export function ConnectionNotice({ state }: { state: ProviderReconnectState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.retryAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.retryAt]);
  const seconds = secondsUntil(state.retryAt, now);
  return (
    <div className="connectionNotice" role="status" aria-live="polite">
      <Loader2 className="connectionNoticeSpinner" size={13} aria-hidden="true" />
      <span>Reconnecting to the model server</span>
      <b>
        {state.attempt}/{state.maxAttempts}
        {seconds !== null ? ` · ${seconds > 0 ? `${seconds}s` : "now"}` : ""}
      </b>
    </div>
  );
}
