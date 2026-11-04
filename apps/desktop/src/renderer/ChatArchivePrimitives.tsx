import React from "react";
import { ChevronDown, FolderPlus, Search, SquarePen, Trash2 } from "lucide-react";
import { ShortcutTooltip } from "./Tooltip";

export function ChatArchiveToolbar({ query, disabled, onQueryChange, onNew, onAddFolder }: {
  query: string; disabled: boolean; onQueryChange(query: string): void; onNew(): void; onAddFolder(): void;
}) {
  return <>
    <div className="workspaceArchiveActions">
      <ShortcutTooltip id="chat.new" placement="bottom"><button className="workspaceNewChat" type="button" aria-label="New chat" disabled={disabled} onClick={onNew}><SquarePen size={16}/><span>New chat</span></button></ShortcutTooltip>
      <button className="cloudIconButton" type="button" disabled={disabled} onClick={onAddFolder} aria-label="New project" title="New project"><FolderPlus size={17}/></button>
    </div>
    <label className="workspaceChatSearch"><Search size={14}/><input aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => onQueryChange(event.target.value)}/></label>
  </>;
}

export function ChatProjectSection({ name, path, collapsed, disabled, onToggle, onNew, actions, children, hasWorktrees = false }: {
  name: string; path?: string; collapsed: boolean; disabled?: boolean; onToggle(): void; onNew?(): void;
  actions?: React.ReactNode; children: React.ReactNode; hasWorktrees?: boolean;
}) {
  return <section className="chatProject">
    <div className="chatProjectHeader">
      <button className="chatProjectToggle" type="button" onClick={onToggle} aria-expanded={!collapsed} title={path || name}>
        <ChevronDown className={collapsed ? "collapsed" : ""} size={14}/><span><strong>{name}</strong></span>
      </button>
      {onNew && <button className="chatProjectNewButton" type="button" disabled={disabled} onClick={onNew} title={`Start a new chat in "${name}"`}><SquarePen size={14}/></button>}
      {actions}
    </div>
    {!collapsed && <div className={`chatProjectChats ${hasWorktrees ? "hasWorktrees" : ""}`}>{children}</div>}
  </section>;
}

export function ChatArchiveRow({ title, active, closed, disabled, deleteDisabled, icon, detail, updatedAt, status, onSelect, onDelete }: {
  title: string; active: boolean; closed?: boolean; disabled?: boolean; deleteDisabled?: boolean;
  icon?: React.ReactNode; detail?: string; updatedAt?: string; status?: React.ReactNode; onSelect(): void; onDelete(): void;
}) {
  return <div className={`chatRow ${active ? "active" : ""} ${closed ? "closed" : ""}`}>
    <button className="chatRowMain" type="button" disabled={disabled} onClick={onSelect} aria-current={active ? "page" : undefined} title={title}>
      <span className={`chatRowContent ${icon ? "hasConnection" : ""}`}>{icon}<strong>{title}</strong>{status || (detail && <em title={updatedAt}>{detail}</em>)}</span>
    </button>
    <button className="chatDeleteButton" type="button" disabled={disabled || deleteDisabled} title="Delete chat" aria-label={`Delete ${title}`} onClick={event => { event.stopPropagation(); onDelete(); }}><Trash2 size={14}/></button>
  </div>;
}
