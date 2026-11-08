import React, { useEffect, useId, useRef } from "react";
import { FolderX, MessageSquareX, Trash2 } from "lucide-react";

/** Shared destructive-action presentation and native focus trapping for every provider. */
export function ConfirmationDialog({ title, description, actionLabel, kind = "chat", busy = false, error, onCancel, onConfirm }: {
  title: string; description: string; actionLabel: string; kind?: "chat" | "chats" | "project";
  busy?: boolean; error?: string | null; onCancel(): void; onConfirm(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const Icon = kind === "project" ? FolderX : kind === "chats" ? MessageSquareX : Trash2;
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    confirmRef.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="riskDialog deleteDialog confirmationDialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <div className="dialogIcon deleteIcon" aria-hidden="true"><Icon size={18}/></div>
    <div><h3 id={`${id}-title`}>{title}</h3><p id={`${id}-description`}>{description}</p></div>
    {error && <p className="confirmationError" role="alert">{error}</p>}
    <div className="dialogActions">
      <button className="secondaryAction" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button ref={confirmRef} className="dangerAction" type="button" autoFocus disabled={busy} onClick={onConfirm}><Icon size={14}/>{busy ? "Working…" : actionLabel}</button>
    </div>
  </dialog>;
}
