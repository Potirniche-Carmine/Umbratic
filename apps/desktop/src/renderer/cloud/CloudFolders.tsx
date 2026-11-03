import React, { useRef } from "react";
import { Check, FolderOpen, Plus } from "lucide-react";
import type { RepositoryInfo } from "../../shared/desktopApi";

export function CloudFolders({ projects, selectedIds, disabled, onChange, onAdd }: {
  projects: RepositoryInfo[]; selectedIds: string[]; disabled: boolean;
  onChange(ids: string[]): void; onAdd(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const selected = projects.filter(project => selectedIds.includes(project.id)).sort((a, b) => a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0);
  return <div className="cloudFolderPicker">
    <button type="button" className="cloudIconButton" aria-label="Workspace folders" title="Workspace folders" aria-haspopup="dialog" disabled={disabled} onClick={event => {
      const element = menu.current!;
      if (element.matches(":popover-open")) { element.hidePopover(); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 332))}px`; element.style.top = `${rect.bottom + 8}px`; element.showPopover();
    }}><FolderOpen size={17}/></button>
    <span className="cloudWorkspaceName" title={selected.map(project => project.rootPath).join("\n")}>{selected.length ? selected.slice(0, 2).map((project, index) => <React.Fragment key={project.id}>{index > 0 && <span className="cloudFolderSeparator" aria-hidden="true">/</span>}{project.name}</React.Fragment>) : "Workspace"}{selected.length > 2 && <span>+{selected.length - 2}</span>}</span>
    <div ref={menu} popover="auto" role="dialog" aria-label="Workspace folders" className="cloudFoldersMenu">
      {projects.map(project => <button key={project.id} type="button" role="checkbox" aria-checked={selectedIds.includes(project.id)} disabled={disabled} onClick={() => onChange(selectedIds.includes(project.id) ? selectedIds.filter(id => id !== project.id) : [...selectedIds, project.id])}>
        <Check size={15} style={{ visibility: selectedIds.includes(project.id) ? "visible" : "hidden" }}/><span><strong>{project.name}</strong><small>{project.rootPath}</small></span>
      </button>)}
      <button type="button" disabled={disabled} onClick={() => { menu.current?.hidePopover(); onAdd(); }}><Plus size={16}/><span>Add folders…</span></button>
    </div>
  </div>;
}
