import React, { useRef, useState } from "react";
import { Check, Folder, Plus } from "lucide-react";
import { compactPath } from "../compactPath";
import { Tooltip } from "../Tooltip";
import type { RepositoryInfo } from "../../shared/desktopApi";

export function CloudFolders({ projects, selectedIds, disabled, onChange, onAdd }: {
  projects: RepositoryInfo[]; selectedIds: string[]; disabled: boolean;
  onChange(ids: string[]): void; onAdd(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = projects.filter(project => selectedIds.includes(project.id)).sort((a, b) => a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0);
  return <div className="cloudFolderPicker">
    <Tooltip content="Workspace folders" placement="bottom" disabled={open}><button ref={trigger} type="button" className="cloudIconButton" aria-label="Workspace folders" aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={event => {
      const element = menu.current!;
      if (element.matches(":popover-open")) { element.hidePopover(); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 292))}px`; element.style.top = `${rect.bottom + 8}px`; element.showPopover();
      if (event.detail === 0) element.querySelector<HTMLButtonElement>("[role=checkbox]")?.focus();
    }}><Folder size={18} strokeWidth={1.6}/></button></Tooltip>
    <span className="cloudWorkspaceName" title={selected.map(project => project.rootPath).join("\n")}>{selected.length ? selected.slice(0, 2).map((project, index) => <React.Fragment key={project.id}>{index > 0 && <span className="cloudFolderSeparator" aria-hidden="true">·</span>}{project.name}</React.Fragment>) : "Workspace"}{selected.length > 2 && <span>+{selected.length - 2}</span>}</span>
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
        return <button key={project.id} type="button" role="checkbox" aria-checked={selectedIds.includes(project.id)} title={project.rootPath} disabled={disabled} onClick={() => onChange(selectedIds.includes(project.id) ? selectedIds.filter(id => id !== project.id) : [...selectedIds, project.id])}>
          <span className="cloudFolderGlyph"><Folder size={17} strokeWidth={1.6}/></span><span className="cloudFolderIdentity"><strong>{project.name}</strong>{duplicate && <small>{compactPath(project.rootPath, projects.map(item => item.rootPath))}</small>}</span><Check className="cloudFolderCheck" size={14} style={{ visibility: selectedIds.includes(project.id) ? "visible" : "hidden" }}/>
        </button>;
      })}</div>
    </div>
  </div>;
}
