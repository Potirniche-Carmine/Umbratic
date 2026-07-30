import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, LogIn, Trash2 } from "lucide-react";

type CompanyServerActionsProps = {
  active: boolean;
  busy: boolean;
  connectDisabled: boolean;
  onConnect(): void;
  onUnregister(): void;
};

export function CompanyServerActions({
  active,
  busy,
  connectDisabled,
  onConnect,
  onUnregister,
}: CompanyServerActionsProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const unregisterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!confirmationOpen) return undefined;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmationOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
      if (!controls.length) return;
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
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      unregisterTriggerRef.current?.focus();
    };
  }, [confirmationOpen]);

  const confirmationDialog = confirmationOpen ? createPortal(
    <div className="modalScrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setConfirmationOpen(false);
    }}>
      <section
        ref={dialogRef}
        className="riskDialog unregisterCompanyDialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unregister-company-title"
        aria-describedby="unregister-company-description"
      >
        <div className="dialogIcon deleteIcon"><Trash2 size={18} /></div>
        <div>
          <h3 id="unregister-company-title">Unregister this device?</h3>
          <p id="unregister-company-description">
            You will lose access to this company server. To connect again, you must ask your administrator for a new enrollment key.
          </p>
        </div>
        <div className="dialogActions">
          <button className="secondaryAction" type="button" autoFocus onClick={() => setConfirmationOpen(false)}>Cancel</button>
          <button className="dangerAction" type="button" onClick={() => {
            setConfirmationOpen(false);
            onUnregister();
          }}>
            <Trash2 size={14} />
            Unregister
          </button>
        </div>
      </section>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div className="companyEnrollmentActions">
        {!active ? (
          <button className="primaryAction companyServerConnectAction" type="button" onClick={onConnect} disabled={connectDisabled}>
            {busy ? <Loader2 className="spin" size={14} /> : <LogIn size={14} />}
            <span>{busy ? "Connecting" : "Connect"}</span>
          </button>
        ) : null}
        <button
          ref={unregisterTriggerRef}
          className="settingsInlineButton companyServerUnregisterAction"
          type="button"
          onClick={() => setConfirmationOpen(true)}
          disabled={busy}
          aria-haspopup="dialog"
        >
          Unregister
        </button>
      </div>
      {confirmationDialog}
    </>
  );
}
