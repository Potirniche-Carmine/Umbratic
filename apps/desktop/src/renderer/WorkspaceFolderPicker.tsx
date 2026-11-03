import React, { useRef, useState } from "react";
import { Check, Folder, FolderOpen, Plus } from "lucide-react";
import { compactPath } from "./compactPath";
import { Tooltip } from "./Tooltip";
import type { RepositoryInfo } from "../shared/desktopApi";

export function WorkspaceFolderPicker({ projects, selectedIds, disabled, onChange, onAdd, multiple = true }: {
  projects: RepositoryInfo[]; selectedIds: string[]; disabled: boolean; multiple?: boolean;
  onChange(ids: string[]): void; onAdd(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState(selectedIds);
  const selected = projects.filter(project => selectedIds.includes(project.id)).sort((a, b) => a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0);
  return <div className="cloudFolderPicker">
    <Tooltip content="Workspace folders" placement="bottom" disabled={open}><button ref={trigger} type="button" className="workspaceControl" aria-label="Workspace folders" aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={event => {
      const element = menu.current!;
      if (element.matches(":popover-open")) { element.hidePopover(); return; }
      setPendingIds(selectedIds);
      const rect = event.currentTarget.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 292))}px`; element.style.top = "auto"; element.style.bottom = `${window.innerHeight - rect.top + 8}px`; element.style.maxHeight = `${Math.max(120, rect.top - 20)}px`; element.showPopover();
      if (event.detail === 0) element.querySelector<HTMLButtonElement>("[role=checkbox]")?.focus();
    }}><FolderOpen size={14}/><strong>{selected.length ? selected.map(project => project.name).join(" · ") : "Select folder"}</strong></button></Tooltip>
    <div ref={menu} popover="auto" role="dialog" aria-label="Workspace folders" className="cloudFoldersMenu" onToggle={event => setOpen(event.newState === "open")} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); menu.current?.hidePopover(); trigger.current?.focus(); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus();
    }}>
      <header className="cloudFoldersHeading"><span>Folders</span><Tooltip content="Add folders" placement="bottom"><button type="button" className="cloudAddFolder" aria-label="Add folders" disabled={disabled} onClick={() => { menu.current?.hidePopover(); onAdd(); }}><Plus size={17}/></button></Tooltip></header>
      <div className="cloudFolderList">{[...projects].sort((a, b) => a.name.localeCompare(b.name) || a.rootPath.localeCompare(b.rootPath)).map(project => {
        const duplicate = projects.some(other => other.id !== project.id && other.name === project.name);
        return <button key={project.id} type="button" role="checkbox" aria-checked={pendingIds.includes(project.id)} title={project.rootPath} disabled={disabled} onClick={() => { if (!multiple) { menu.current?.hidePopover(); onChange([project.id]); } else setPendingIds(ids => ids.includes(project.id) ? ids.filter(id => id !== project.id) : [...ids, project.id]); }}>
          <span className="cloudFolderGlyph"><Folder size={17} strokeWidth={1.6}/></span><span className="cloudFolderIdentity"><strong>{project.name}</strong>{duplicate && <small>{compactPath(project.rootPath, projects.map(item => item.rootPath))}</small>}</span><Check className="cloudFolderCheck" size={14} style={{ visibility: pendingIds.includes(project.id) ? "visible" : "hidden" }}/>
        </button>;
      })}</div>
      {multiple && <div className="workspaceFolderFooter"><button type="button" className="cloudAction" onClick={() => { menu.current?.hidePopover(); if ([...pendingIds].sort().join("\0") !== [...selectedIds].sort().join("\0")) onChange(pendingIds); }}>Done</button></div>}
    </div>
  </div>;
}
