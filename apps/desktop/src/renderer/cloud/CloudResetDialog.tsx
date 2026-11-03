import React, { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";

export function CloudResetDialog({ onCancel, onReset, busy, deleting = false }: { deleting?: boolean; onCancel(): void; onReset(): void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="cloudResetDialog" aria-labelledby="cloud-reset-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <RotateCcw size={24}/><h2 id="cloud-reset-title">{deleting ? "Delete this chat?" : "Start with fresh context?"}</h2>
    <p>This removes this chat’s saved messages and unused attachment copies from Umbratic. Other chats, workspace files, and the provider’s own session history are kept.</p>
    <div><button className="cloudAction" disabled={busy} onClick={onCancel}>Cancel</button><button className="cloudAction cloudPrimary" disabled={busy} onClick={onReset}>{deleting ? "Delete chat" : "Reset context"}</button></div>
  </dialog>;
}
