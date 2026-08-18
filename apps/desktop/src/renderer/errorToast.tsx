import { useEffect, useRef } from "react";
import { TriangleAlert, X } from "lucide-react";

export const TOAST_LIFETIME_MS = 5_000;

/**
 * A toast is a notice, not a state: it says its sentence and leaves after a
 * few seconds, and the button is for anyone who has already read it. Anything
 * that still matters after that is on the panel it came from.
 */
export function ErrorToast({ message, onDismiss }: { message: string | null; onDismiss(): void }) {
  // The timer is keyed to the message, not to the callback: a caller passing a
  // fresh closure every render must not keep resetting the clock.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => dismiss.current(), TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!message) return null;
  return (
    <div className="toast" role="alert">
      <TriangleAlert size={16} />
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">
        <X size={14} />
      </button>
    </div>
  );
}
