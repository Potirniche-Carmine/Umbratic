import React, { useState } from "react";
import { Ellipsis, MessageSquareX } from "lucide-react";
import type { CloudChatRecord } from "../../shared/cloud";
import type { RepositoryInfo } from "../../shared/desktopApi";
import { relativeChatAge } from "../chatListPresentation";
import { ChatArchiveToolbar, ChatProjectSection, ChatArchiveRow } from "../ChatArchivePrimitives";

type CloudArchiveGroup = { key: string; name: string; path?: string; ids: string[]; chats: CloudChatRecord[] };
export function cloudArchiveGroups(chats: CloudChatRecord[], projects: RepositoryInfo[], query: string): CloudArchiveGroup[] {
  const assigned = new Set<string>();
  const groups = [...projects].sort((a, b) => a.name.localeCompare(b.name) || a.rootPath.localeCompare(b.rootPath)).map(project => {
    const rows = chats.filter(chat => chat.repositoryIds?.includes(project.id) || chat.paths.includes(project.rootPath));
    rows.forEach(chat => assigned.add(chat.key));
    return { key: project.id, name: project.name, path: project.rootPath, ids: [project.id], chats: rows };
  }) as CloudArchiveGroup[];
  const general = chats.filter(chat => !assigned.has(chat.key));
  if (general.length) groups.push({ key: "general", name: "Chats", ids: [], chats: general });
  const search = query.trim().toLowerCase();
  return groups.map(group => !search || group.name.toLowerCase().includes(search) ? group : { ...group, chats: group.chats.filter(chat => chat.title.toLowerCase().includes(search)) })
    .filter(group => !search || group.name.toLowerCase().includes(search) || group.chats.length);
}

type Props = {
  chats: CloudChatRecord[]; projects: RepositoryInfo[]; activeKey?: string; disabled: boolean; loading: boolean;
  onSelect(key: string): void; onNew(repositoryIds?: string[]): void; onAddFolder(): void; onDelete(chats: CloudChatRecord[]): void;
};
export function CloudChatArchive(props: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [menu, setMenu] = useState<string | null>(null);
  return <CloudChatArchiveContent {...props} query={query} onQueryChange={setQuery} collapsed={collapsed} menu={menu} onMenu={setMenu}
    onToggle={key => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}/>;
}
export function CloudChatArchiveContent({ chats, projects, activeKey, disabled, loading, onSelect, onNew, onAddFolder, onDelete, query, onQueryChange, collapsed, onToggle, menu, onMenu }: Props & {
  query: string; onQueryChange(query: string): void; collapsed: Set<string>; onToggle(key: string): void; menu: string | null; onMenu(key: string | null): void;
}) {
  const groups = cloudArchiveGroups(chats, projects, query);
  return <section className="chatArchive" aria-label="Conversations">
    <ChatArchiveToolbar query={query} onQueryChange={onQueryChange} disabled={disabled} onNew={() => onNew()} onAddFolder={onAddFolder}/>
    <div className="chatList">
      {groups.map(group => <ChatProjectSection key={group.key} name={group.name} path={group.path} collapsed={!query.trim() && collapsed.has(group.key)}
        disabled={disabled} onToggle={() => onToggle(group.key)} onNew={group.ids.length ? () => onNew(group.ids) : undefined}
        actions={group.path && <div className="chatProjectActions">
          <button className="chatProjectActionButton" type="button" aria-expanded={menu === group.key} aria-haspopup="menu" title={`Project actions for "${group.name}"`} onClick={() => onMenu(menu === group.key ? null : group.key)}><Ellipsis size={14}/></button>
          {menu === group.key && <div className="chatProjectMenu" role="menu">
            <button type="button" role="menuitem" disabled={disabled || !group.chats.length || group.chats.some(chat => chat.state !== "idle")}
              onClick={() => { onMenu(null); onDelete(group.chats); }}><MessageSquareX size={14}/><span>Delete all chats</span></button>
          </div>}
        </div>}>
        {group.chats.map(chat => <ChatArchiveRow key={chat.key} title={chat.title} active={chat.key === activeKey} disabled={disabled} deleteDisabled={chat.state !== "idle"}
          detail={chat.updatedAt ? relativeChatAge(chat.updatedAt) : ""} updatedAt={chat.updatedAt}
          status={chat.state !== "idle" && <span className={`workspaceActivity is-${chat.state}`} aria-label={chat.state === "waiting" ? "Needs your attention" : "Working"}/>}
          onSelect={() => onSelect(chat.key)} onDelete={() => onDelete([chat])}/>)}
      </ChatProjectSection>)}
      {!groups.length && (loading || query) && <div className="workspaceArchiveEmpty" role="status">{loading ? "Loading chats…" : "No matching chats"}</div>}
    </div>
  </section>;
}
