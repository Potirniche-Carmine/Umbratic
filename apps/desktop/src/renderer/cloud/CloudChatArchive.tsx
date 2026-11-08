import React, { useLayoutEffect, useState } from "react";
import { FolderX, MessageSquareX } from "lucide-react";
import type { CloudChatRecord } from "../../shared/cloud";
import type { RepositoryInfo } from "../../shared/desktopApi";
import { chatJumpNumbers, relativeChatAge } from "../chatListPresentation";
import { useChatJumpShortcuts } from "../useChatJumpShortcuts";
import { ChatProjectMenu } from "../ChatProjectMenu";
import { ChatArchiveToolbar, ChatProjectSection, ChatArchiveRow } from "../ChatArchivePrimitives";
import { cloudProviderIcons } from "./CloudProviderIcon";
import { workspaceProviderLabels } from "../WorkspaceNavigation";

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
  shortcutsBlocked: boolean;
  unreadChatIds?: ReadonlySet<string>;
  onVisibleChatsChange?(chats: CloudChatRecord[]): void;
  onDeleteProject?(project: RepositoryInfo): void;
  onSelect(key: string): void; onNew(repositoryIds?: string[]): void; onAddFolder(): void; onDelete(chats: CloudChatRecord[]): void;
};
export function visibleCloudChats(groups: CloudArchiveGroup[], collapsed: ReadonlySet<string>, query: string): CloudChatRecord[] {
  const visible = groups.filter(group => query.trim() || !collapsed.has(group.key)).flatMap(group => group.chats);
  return [...new Map(visible.map(chat => [chat.key, chat])).values()];
}
export function CloudChatArchive(props: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [menu, setMenu] = useState<string | null>(null);
  const visible = visibleCloudChats(cloudArchiveGroups(props.chats, props.projects, query), collapsed, query);
  useLayoutEffect(() => { props.onVisibleChatsChange?.(visible); });
  const jumpKeysVisible = useChatJumpShortcuts(visible, chat => props.onSelect(chat.key), props.shortcutsBlocked || props.disabled || menu !== null);
  return <CloudChatArchiveContent {...props} query={query} onQueryChange={setQuery} collapsed={collapsed} menu={menu} onMenu={setMenu}
    jumpKeysVisible={jumpKeysVisible}
    onToggle={key => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}/>;
}
export function CloudChatArchiveContent({ chats, projects, activeKey, disabled, loading, unreadChatIds, onSelect, onNew, onAddFolder, onDelete, onDeleteProject, query, onQueryChange, collapsed, onToggle, menu, onMenu, jumpKeysVisible }: Props & {
  query: string; onQueryChange(query: string): void; collapsed: Set<string>; onToggle(key: string): void; menu: string | null; onMenu(key: string | null): void;
  jumpKeysVisible?: boolean;
}) {
  const groups = cloudArchiveGroups(chats, projects, query);
  const numbers = chatJumpNumbers(visibleCloudChats(groups, collapsed, query).map(chat => ({ id: chat.key })));
  return <section className="chatArchive" aria-label="Conversations">
    <ChatArchiveToolbar query={query} onQueryChange={onQueryChange} disabled={disabled} onNew={() => onNew()} onAddFolder={onAddFolder}/>
    <div className="chatList">
      {groups.map(group => <ChatProjectSection key={group.key} name={group.name} path={group.path} collapsed={!query.trim() && collapsed.has(group.key)}
        disabled={disabled} onToggle={() => onToggle(group.key)} onNew={group.ids.length ? () => onNew(group.ids) : undefined}
        actions={group.path && <ChatProjectMenu name={group.name} open={menu === group.key}
          onOpenChange={open => onMenu(open ? group.key : null)} actions={[
            { id: "chats", label: "Delete all chats", icon: <MessageSquareX size={14}/>,
              disabled: disabled || !group.chats.length || group.chats.some(chat => chat.state !== "idle"), onSelect: () => onDelete(group.chats) },
            ...(onDeleteProject ? [{ id: "project", label: "Delete project", icon: <FolderX size={14}/>, danger: true, disabled: disabled || group.chats.some(chat => chat.state !== "idle"), onSelect: () => onDeleteProject(projects.find(project => project.id === group.key)!) }] : []),
          ]}/> }>
        {group.chats.map(chat => <ChatArchiveRow key={chat.key} title={chat.title} active={chat.key === activeKey} disabled={disabled} deleteDisabled={chat.state !== "idle"}
          detail={chat.updatedAt ? relativeChatAge(chat.updatedAt) : ""} updatedAt={chat.updatedAt}
          icon={jumpKeysVisible && numbers.has(chat.key) ? <span className="chatJumpKey" aria-hidden="true">{numbers.get(chat.key)}</span>
            : <span className="chatConnectionIcon" role="img" aria-label={workspaceProviderLabels[chat.provider]}>{cloudProviderIcons[chat.provider]}</span>}
          status={chat.state}
          unread={unreadChatIds?.has(chat.key)}
          onSelect={() => onSelect(chat.key)} onDelete={() => onDelete([chat])}/>)}
      </ChatProjectSection>)}
      {!groups.length && (loading || query) && <div className="workspaceArchiveEmpty" role="status">{loading ? "Loading chats…" : "No matching chats"}</div>}
    </div>
  </section>;
}
