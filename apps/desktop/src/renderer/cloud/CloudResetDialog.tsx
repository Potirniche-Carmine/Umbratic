import React, { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";

export function CloudResetDialog({ onCancel, onReset, busy }: { onCancel(): void; onReset(): void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="cloudResetDialog" aria-labelledby="cloud-reset-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <RotateCcw size={24}/><h2 id="cloud-reset-title">Start with fresh context?</h2>
    <p>This deletes Umbratic’s saved conversation and its unused attachment copies for both providers, then starts a new session. Workspace files and the providers’ own session history are kept.</p>
    <div><button className="cloudAction" disabled={busy} onClick={onCancel}>Cancel</button><button className="cloudAction cloudPrimary" disabled={busy} onClick={onReset}>Reset context</button></div>
  </dialog>;
}
