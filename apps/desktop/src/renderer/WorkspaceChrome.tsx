import React from "react";
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

export function WorkspaceIdePicker({ choices, selected, disabled, open, title, onOpen, onToggle, onSelect }: {
  choices: IdeInfo[]; selected: IdeInfo; disabled: boolean; open: boolean; title: string;
  onOpen(): void; onToggle(): void; onSelect(id: string): void;
}) {
  return <div className={`idePicker ${disabled ? "isDisabled" : ""}`}>
    <button className="idePickerOpen" type="button" onClick={onOpen} disabled={disabled} title={title}><IdeIcon icon={selected.icon}/></button>
    <button className="idePickerToggle" type="button" onClick={onToggle} disabled={disabled} aria-expanded={open} aria-haspopup="menu" title={disabled ? title : "Choose editor"}><ChevronDown size={13}/></button>
    {open && <div className="ideMenu" role="menu" onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
    }}>
      {choices.map(ide => <button className={ide.id === selected.id ? "active" : ""} key={ide.id} type="button" role="menuitem" onClick={() => onSelect(ide.id)}><IdeIcon icon={ide.icon}/><span>{ide.label}</span></button>)}
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
