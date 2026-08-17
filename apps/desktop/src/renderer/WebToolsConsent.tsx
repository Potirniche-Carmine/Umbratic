import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Listener = (enabled: boolean) => void;

let current = false;
let hydrated = false;
const listeners = new Set<Listener>();

function publish(enabled: boolean) {
  current = enabled;
  for (const listener of listeners) listener(enabled);
}

export function hydrateWebToolsState(enabled: boolean) {
  if (hydrated) return;
  hydrated = true;
  publish(enabled);
}

export function useWebToolsEnabled(initial?: boolean) {
  const [enabled, setEnabled] = useState(() => {
    if (initial !== undefined) hydrateWebToolsState(initial);
    return current;
  });
  useEffect(() => {
    listeners.add(setEnabled);
    return () => {
      listeners.delete(setEnabled);
    };
  }, []);
  return enabled;
}

export async function persistWebTools(
  next: boolean,
  setWebTools: (enabled: boolean) => Promise<boolean>,
  onError: (message: string) => void,
) {
  const previous = current;
  publish(next);
  try {
    publish(await setWebTools(next));
  } catch (cause) {
    publish(previous);
    onError(String(cause instanceof Error ? cause.message : cause));
  }
}

/**
 * Asks before web tools go on. Pages on the public web are not a trusted
 * workspace, and turning this on is the consent to reach them.
 */
export function WebToolsConsentDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return createPortal(
    <div
      className="modalScrim isNested"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="riskDialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="web-tools-consent-title"
        aria-describedby="web-tools-consent-description"
      >
        <div>
          <h3 id="web-tools-consent-title">Turn on web search?</h3>
          <p id="web-tools-consent-description">
            The model will send search queries and fetch pages from this machine. Sites can be malicious, and page text is fed back into the model — including attempts to steer the run.
          </p>
        </div>
        <div className="dialogActions">
          <button className="secondaryAction" type="button" autoFocus onClick={onCancel}>
            Stay offline
          </button>
          <button className="primaryAction" type="button" onClick={onConfirm}>
            Turn on
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
