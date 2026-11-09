import React, { useEffect, useRef } from "react";
import { FileText, X } from "lucide-react";
import { ShortcutTooltip } from "./Tooltip";

export function AttachmentPreviewDialog({ name, imageUrl, onClose }: { name: string; imageUrl?: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="imagePreviewDialog sharedAttachmentPreview" aria-label={name}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="imagePreviewHeader"><strong>{name}</strong>
      <ShortcutTooltip id="dialog.dismiss" label="Close preview"><button className="messageAction" type="button" onClick={onClose} aria-label="Close preview"><X size={15}/></button></ShortcutTooltip>
    </div>
    <div className="imagePreviewCanvas">{imageUrl ? <img alt={name} src={imageUrl}/> : <div className="attachmentFilePlaceholder"><FileText size={32}/><p>{name}</p></div>}</div>
  </dialog>;
}
