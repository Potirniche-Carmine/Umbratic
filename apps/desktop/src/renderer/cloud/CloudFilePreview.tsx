import { ShortcutTooltip } from "../Tooltip";
import React, { useEffect, useRef, useState } from "react";
import { FileCode2, X } from "lucide-react";
import type { DesktopApi } from "../../shared/desktopApi";
import type { SourceHighlight } from "../sourceSyntax";
import sourceWorkerUrl from "../sourceSyntax.worker.ts?worker&url";

export function CloudFilePreview({ api, workspaceKey, path, line, onClose }: {
  api: DesktopApi; workspaceKey: string; path: string; line?: number; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLPreElement>(null);
  const activeLine = useRef<HTMLSpanElement>(null);
  const [file, setFile] = useState<{ path: string; text: string }>();
  const [syntax, setSyntax] = useState<SourceHighlight | null>(null);
  const [selectedLine, setSelectedLine] = useState(line);
  const [error, setError] = useState("");
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    let cancelled = false;
    setFile(undefined); setSyntax(null); setError(""); setSelectedLine(line);
    void api.readCloudFile({ key: workspaceKey, path }).then(value => { if (!cancelled) setFile(value); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [api, workspaceKey, path, line]);
  useEffect(() => {
    if (!file) return;
    const worker = new Worker(sourceWorkerUrl, { type: "module" });
    worker.onmessage = (event: MessageEvent<SourceHighlight | null>) => setSyntax(event.data);
    worker.postMessage(file);
    return () => worker.terminate();
  }, [file]);
  function revealLine() { activeLine.current?.scrollIntoView({ block: "center", behavior: "instant" }); }
  useEffect(() => { if (selectedLine) revealLine(); else if (scroller.current) scroller.current.scrollTop = 0; }, [file, selectedLine]);
  const lines = file?.text.split(/\r?\n/) || [];
  const validLine = selectedLine !== undefined && selectedLine >= 1 && selectedLine <= lines.length;
  const parts = (file?.path || path).split(/[\\/]/);
  return <dialog ref={dialog} className="cloudFilePreview" aria-label="File preview" onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><FileCode2 size={18} strokeWidth={1.6}/><div className="cloudFileIdentity" title={file?.path || path}><strong>{parts.at(-1)}</strong><span>{parts.slice(-3, -1).join(" / ")}</span></div>
      {selectedLine !== undefined && <button className="cloudFileLocation" onClick={revealLine} disabled={!validLine} title={validLine ? "Jump to selected line" : "This line is no longer in the file"}>Line {selectedLine}{file && !validLine ? " unavailable" : ""}</button>}
      <ShortcutTooltip id="dialog.dismiss" label="Close preview"><button className="cloudIconButton" aria-label="Close file preview" onClick={onClose}><X size={18}/></button></ShortcutTooltip></header>
    {error ? <p role="alert">{error}</p> : !file ? <p role="status">Opening file…</p> : <pre ref={scroller} tabIndex={0} aria-label="Source code">{lines.map((text, index) => <span key={index} ref={index + 1 === selectedLine ? activeLine : undefined} className={`sourceLine ${index + 1 === selectedLine ? "isCurrentLine" : ""}`}>
      <button className="sourceLineNumber" tabIndex={-1} aria-label={`Select line ${index + 1}`} onClick={() => setSelectedLine(index + 1)}>{index + 1}</button>
      <code>{syntax?.lines[index]?.map((token, tokenIndex) => <span key={tokenIndex} className="sourceToken" style={{ "--syntax-dark": token.dark, "--syntax-light": token.light, fontStyle: token.italic ? "italic" : undefined, fontWeight: token.bold ? 600 : undefined } as React.CSSProperties}>{token.content || " "}</span>) || text || " "}</code>
    </span>)}</pre>}
    {file && <footer><span>{syntax?.language || "Source"}</span><span>{lines.length.toLocaleString()} lines</span></footer>}
  </dialog>;
}
