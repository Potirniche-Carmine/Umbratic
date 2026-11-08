import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, PanelRight, Settings } from "lucide-react";
import type { IdeInfo } from "../shared/desktopApi";
import { IdeIcon } from "./ideLogos";
import { ShortcutTooltip } from "./Tooltip";
import { trackPanelResize } from "./panelResize";

export function WorkspaceSettingsButton({ onClick }: { onClick(): void }) {
  return <ShortcutTooltip id="app.settings"><button className="settingsPlaceholder" type="button" aria-label="Settings" onClick={onClick}><Settings size={16}/><span>Settings</span></button></ShortcutTooltip>;
}

export function WorkspaceHeader({ title, meta, indexing, children }: { title: string; meta: React.ReactNode; indexing?: boolean; children: React.ReactNode }) {
  return <div className="composerHeader">
    <div className="composerHeaderTitle"><strong>{title}</strong><div className="composerHeaderMetaRow">{meta}</div>
      {indexing && <span className="workspaceIndexing" role="status"><span className="workspaceIndexingSpinner" aria-hidden="true"/>Indexing workspace…</span>}
    </div>
    <div className="composerHeaderActions">{children}</div>
  </div>;
}

export function WorkspaceReviewToggle({ open, closing = false, onClick }: { open: boolean; closing?: boolean; onClick(): void }) {
  const label = closing ? "Keep review open" : open ? "Hide review" : "Open review";
  return <ShortcutTooltip id="review.toggle" label={label} placement="bottom"><button className="chromeButton composerReviewToggle" type="button" onClick={onClick} aria-pressed={open && !closing} aria-label={label}><PanelRight size={15}/></button></ShortcutTooltip>;
}

export function WorkspaceIdePicker({ choices, selected, disabled, title, onOpen, onSelect }: {
  choices: IdeInfo[]; selected: IdeInfo; disabled: boolean; title: string;
  onOpen(id: string): void; onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    picker.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return <div ref={picker} className={`idePicker ${disabled ? "isDisabled" : ""}`} onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
  }}>
    <button ref={trigger} className="idePickerTrigger" type="button" onClick={() => setOpen(value => !value)} disabled={disabled} aria-label={title} aria-expanded={open && !disabled} aria-haspopup="menu" title={title}><IdeIcon icon={selected.icon}/><ChevronDown size={12}/></button>
    {open && !disabled && <div className="ideMenu" role="menu" aria-label="Open file with" onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
    }}>
      {choices.map(ide => <button className={ide.id === selected.id ? "active" : ""} key={ide.id} type="button" role="menuitem" onClick={() => { onSelect(ide.id); onOpen(ide.id); setOpen(false); trigger.current?.focus(); }}><IdeIcon icon={ide.icon}/><span>Open in {ide.label}</span></button>)}
    </div>}
  </div>;
}

export function WorkspaceSidebarResize({ width, onChange }: { width: number; onChange: React.Dispatch<React.SetStateAction<number>> }) {
  const max = () => Math.min(300, Math.max(196, Math.round(window.innerWidth * .34)));
  const clamp = (value: number) => Math.min(max(), Math.max(196, value));
  return <div className="sidebarResizeHandle" role="separator" tabIndex={0} aria-orientation="vertical" aria-valuemin={196} aria-valuemax={max()} aria-valuenow={Math.round(width)} aria-label="Sidebar width"
    onPointerDown={event => { const x = event.clientX; trackPanelResize(event, next => onChange(clamp(width + next - x)), () => onChange(current => clamp(current))); }}
    onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onChange(current => clamp(current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 24 : 8))); } }}/>;
}
