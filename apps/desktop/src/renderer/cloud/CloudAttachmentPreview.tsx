import { ShortcutTooltip } from "../Tooltip";
import React, { useEffect, useRef } from "react";
import { FileText, X } from "lucide-react";
import type { CloudImage } from "../../shared/cloud";

export function CloudAttachmentPreview({ file, onClose }: { file: CloudImage; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="cloudAttachmentPreview" aria-label="Attachment preview" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <ShortcutTooltip id="dialog.dismiss" label="Close preview"><button className="cloudIconButton" aria-label="Close attachment preview" onClick={onClose}><X size={20}/></button></ShortcutTooltip>
    {file.previewDataUrl ? <img src={file.previewDataUrl} alt={file.name}/> : <div><FileText size={32}/><p>{file.name}</p></div>}
  </dialog>;
}
