import { ShortcutTooltip } from "../Tooltip";
import React, { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import type { DesktopApi } from "../../shared/desktopApi";

export function CloudFilePreview({ api, workspaceKey, path, line, onClose }: {
  api: DesktopApi; workspaceKey: string; path: string; line?: number; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const activeLine = useRef<HTMLSpanElement>(null);
  const [file, setFile] = useState<{ path: string; text: string }>();
  const [error, setError] = useState("");
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    let cancelled = false;
    setFile(undefined); setError("");
    void api.readCloudFile({ key: workspaceKey, path }).then(value => { if (!cancelled) setFile(value); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [api, workspaceKey, path]);
  useEffect(() => { activeLine.current?.scrollIntoView({ block: "center" }); }, [file, line]);
  return <dialog ref={dialog} className="cloudFilePreview" aria-label="File preview" onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><FileText size={17}/><span title={file?.path || path}>{path.split(/[\\/]/).pop()}</span><ShortcutTooltip id="dialog.dismiss" label="Close preview"><button className="cloudIconButton" aria-label="Close file preview" onClick={onClose}><X size={18}/></button></ShortcutTooltip></header>
    {error ? <p role="alert">{error}</p> : !file ? <p role="status">Opening file…</p> : <pre>{file.text.split("\n").map((text, index) => <span key={index} ref={index + 1 === line ? activeLine : undefined} className={index + 1 === line ? "isCurrentLine" : undefined}><small aria-hidden="true">{index + 1}</small><code>{text || " "}</code></span>)}</pre>}
  </dialog>;
}
