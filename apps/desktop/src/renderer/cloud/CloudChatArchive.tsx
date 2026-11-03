import React, { useMemo, useState } from "react";
import { Folder, FolderPlus, MessageSquareText, Search, SquarePen, Trash2 } from "lucide-react";
import type { CloudChatRecord } from "../../shared/cloud";
import type { RepositoryInfo } from "../../shared/desktopApi";
import { ShortcutTooltip } from "../Tooltip";

export function CloudChatArchive({ chats, projects, activeKey, disabled, loading, onSelect, onNew, onAddFolder, onDelete }: {
  chats: CloudChatRecord[]; projects: RepositoryInfo[]; activeKey?: string; disabled: boolean; loading: boolean;
  onSelect(key: string): void; onNew(repositoryIds?: string[]): void; onAddFolder(): void; onDelete(chat: CloudChatRecord): void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const result = new Map<string, { name: string; ids: string[]; chats: CloudChatRecord[] }>();
    for (const chat of chats) {
      const folders = projects.filter(project => chat.repositoryIds?.includes(project.id) || chat.paths.includes(project.rootPath));
      const key = folders.map(project => project.id).sort().join("/");
      const name = folders.length ? folders.map(project => project.name).join(" + ") : "Chats";
      if (query && !`${chat.title} ${name}`.toLowerCase().includes(query.toLowerCase())) continue;
      if (!result.has(key)) result.set(key, { name, ids: folders.map(project => project.id), chats: [] });
      result.get(key)!.chats.push(chat);
    }
    return [...result.entries()];
  }, [chats, projects, query]);
  return <section className="chatArchive cloudChatArchive" aria-label="Conversations">
    <div className="workspaceArchiveActions">
      <ShortcutTooltip id="chat.new" placement="bottom"><button className="workspaceNewChat" disabled={disabled} onClick={() => onNew()}><SquarePen size={16}/><span>New chat</span></button></ShortcutTooltip>
      <button className="cloudIconButton" aria-label="Add workspace folder" title="Add workspace folder" disabled={disabled} onClick={onAddFolder}><FolderPlus size={17}/></button>
    </div>
    <label className="workspaceChatSearch"><Search size={14}/><input aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <div className="chatList">
      {groups.map(([key, group]) => <section className="chatProject" key={key}>
        <div className="workspaceChatGroup"><span>{group.ids.length ? <Folder size={13}/> : <MessageSquareText size={13}/>} {group.name}</span>
          {group.ids.length > 0 && <button className="cloudIconButton" aria-label={`New chat in ${group.name}`} disabled={disabled} onClick={() => onNew(group.ids)}><SquarePen size={13}/></button>}
        </div>
        {group.chats.map(chat => <div key={chat.key} className={`chatRow ${chat.key === activeKey ? "active" : ""}`}>
          <button className="chatRowMain" disabled={disabled} aria-current={chat.key === activeKey ? "page" : undefined} onClick={() => onSelect(chat.key)} title={chat.title}>
            <span className="chatRowContent"><strong>{chat.title}</strong>{chat.state !== "idle" && <span className={`workspaceActivity is-${chat.state}`} aria-label={chat.state === "waiting" ? "Needs your attention" : "Working"}/>}</span>
          </button>
          <button className="chatDeleteButton" disabled={disabled || chat.state !== "idle"} aria-label={`Delete ${chat.title}`} onClick={() => onDelete(chat)}><Trash2 size={13}/></button>
        </div>)}
      </section>)}
      {!groups.length && <div className="workspaceArchiveEmpty">{loading ? "Loading chats…" : query ? "No matching chats" : <><MessageSquareText size={20}/><strong>A fresh space for your work</strong><span>Your conversations will appear here.</span></>}</div>}
    </div>
  </section>;
}
