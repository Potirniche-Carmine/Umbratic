import React, { useState } from "react";
import { ChevronDown, CircleDashed, Cloud, Ellipsis, FolderPlus, FolderX, GitBranch, MessageSquareX, Monitor, Search, SquarePen, Trash2 } from "lucide-react";
import type { ChatRecord } from "../shared/desktopApi";
import { chatDisplayTitle, chatSubline, closedChatMessage, worktreeTitle, type ChatProjectGroup, type DeleteCandidate, type ProjectDeleteTarget, type WorktreeChatGroup } from "./chatListPresentation";
import { ShortcutTooltip } from "./Tooltip";

type ChatArchiveProps = {
  chatProjectGroups: ChatProjectGroup[];
  activeChatId: string | null;
  chatJumpKeysVisible: boolean;
  chatJumpNumbersById: Map<string, number>;
  collapsedProjectKeys: Set<string>;
  collapsedWorktreeKeys: Set<string>;
  projectActionMenuKey: string | null;
  setProjectActionMenuKey: React.Dispatch<React.SetStateAction<string | null>>;
  setDeleteCandidate: (candidate: DeleteCandidate) => void;
  chatProjectTarget: (group: ChatProjectGroup) => ProjectDeleteTarget | null;
  toggleProjectGroup: (key: string) => void;
  toggleWorktreeGroup: (key: string) => void;
  selectChat: (chat: ChatRecord) => Promise<void>;
  newChat: () => Promise<void>;
  newProject: () => Promise<void>;
  newChatForProject: (project: { name: string; path?: string }) => Promise<void>;
  newChatForWorktree: (project: { name: string; path?: string }, worktree: WorktreeChatGroup) => Promise<void>;
  busy: boolean;
};

export function ChatArchive(props: ChatArchiveProps) {
  const [query, setQuery] = useState("");
  return <ChatArchiveContent {...props} query={query} onQueryChange={setQuery}/>;
}

export function ChatArchiveContent({
  chatProjectGroups, activeChatId, chatJumpKeysVisible, chatJumpNumbersById,
  collapsedProjectKeys, collapsedWorktreeKeys, projectActionMenuKey,
  setProjectActionMenuKey, setDeleteCandidate, chatProjectTarget,
  toggleProjectGroup, toggleWorktreeGroup, selectChat, newChat, newProject,
  newChatForProject, newChatForWorktree, busy, query, onQueryChange,
}: ChatArchiveProps & { query: string; onQueryChange(query: string): void }) {
  const search = query.trim().toLowerCase();
  const visibleGroups = chatProjectGroups.map(group => !search || group.name.toLowerCase().includes(search) ? group : ({ ...group,
    chats: group.chats.filter(chat => chatDisplayTitle(chat).toLowerCase().includes(search)),
    worktrees: group.worktrees.map(tree => ({ ...tree, chats: tree.chats.filter(chat => chatDisplayTitle(chat).toLowerCase().includes(search)) })).filter(tree => tree.chats.length),
  })).filter(group => !search || group.name.toLowerCase().includes(search) || group.chats.length || group.worktrees.length);
  function renderChatRow(chat: ChatRecord) {
    const connectionLabel = chat.modelEndpointMode === "server"
      ? "Company server"
      : chat.modelEndpointMode === "local"
        ? "Local model"
        : "";
    // The number takes the connection icon's place rather than sitting beside
    // it: the slot is already the right size, so holding the modifier changes
    // what the row starts with without moving a single word of it.
    const jumpNumber = chatJumpKeysVisible ? chatJumpNumbersById.get(chat.id) : undefined;
    return (
      <div
        className={`chatRow ${activeChatId === chat.id ? "active" : ""} ${
          closedChatMessage(chat.taskState) ? "closed" : ""
        }`}
        key={chat.id}
      >
        <button className="chatRowMain" type="button" onClick={() => selectChat(chat)}>
          <span className={`chatRowContent ${connectionLabel || jumpNumber ? "hasConnection" : ""}`}>
            {jumpNumber ? (
              <span className="chatJumpKey" aria-hidden="true">{jumpNumber}</span>
            ) : connectionLabel ? (
              <span className="chatConnectionIcon" role="img" aria-label={connectionLabel} title={connectionLabel}>
                {chat.modelEndpointMode === "server" ? <Cloud size={12} aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}
              </span>
            ) : null}
            <strong>{chatDisplayTitle(chat)}</strong>
            <em title={chat.updatedAt}>{chatSubline(chat)}</em>
          </span>
        </button>
        <button
          className="chatDeleteButton"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDeleteCandidate({ kind: "chat", chat });
          }}
          title="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  return (
    <section className="chatArchive">
      <div className="workspaceArchiveActions">
        <ShortcutTooltip id="chat.new" placement="bottom"><button className="workspaceNewChat" type="button" onClick={newChat}><SquarePen size={16}/><span>New chat</span></button></ShortcutTooltip>
        <button className="cloudIconButton" type="button" onClick={() => void newProject()} disabled={busy} aria-label="New project" title="New project"><FolderPlus size={17}/></button>
      </div>
      <label className="workspaceChatSearch"><Search size={14}/><input aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => onQueryChange(event.target.value)}/></label>
      <div className="chatList">
        {visibleGroups.length ? (
          visibleGroups.map((group) => {
            const collapsed = !search && collapsedProjectKeys.has(group.key);
            const projectTarget = chatProjectTarget(group);
            return (
              <section className="chatProject" key={group.key}>
                <div className="chatProjectHeader">
                  <button
                    className="chatProjectToggle"
                    type="button"
                    onClick={() => toggleProjectGroup(group.key)}
                    aria-expanded={!collapsed}
                    title={group.path ?? group.name}
                  >
                    <ChevronDown className={collapsed ? "collapsed" : ""} size={14} />
                    <span>
                      <strong>{group.name}</strong>
                    </span>
                  </button>
                  {group.path ? (
                    <button
                      className="chatProjectNewButton"
                      type="button"
                      onClick={() => void newChatForProject({ name: group.name, path: group.path })}
                      title={`Start a new chat in "${group.name}"`}
                    >
                      <SquarePen size={14} />
                    </button>
                  ) : null}
                  {projectTarget ? (
                    <div className="chatProjectActions">
                      <button
                        className="chatProjectActionButton"
                        type="button"
                        onClick={() => {
                          setProjectActionMenuKey((current) => (current === group.key ? null : group.key));
                        }}
                        aria-expanded={projectActionMenuKey === group.key}
                        aria-haspopup="menu"
                        title={`Project actions for "${group.name}"`}
                      >
                        <Ellipsis size={14} />
                      </button>
                      {projectActionMenuKey === group.key ? (
                        <div className="chatProjectMenu" role="menu">
                          {projectTarget.chatCount > 0 ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setProjectActionMenuKey(null);
                                setDeleteCandidate({ kind: "projectChats", project: projectTarget });
                              }}
                            >
                              <MessageSquareX size={14} />
                              <span>Delete all chats</span>
                            </button>
                          ) : null}
                          <button
                            className="danger"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectActionMenuKey(null);
                              setDeleteCandidate({ kind: "project", project: projectTarget });
                            }}
                          >
                            <FolderX size={14} />
                            <span>Delete project</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {!collapsed ? (
                  <div className={`chatProjectChats ${group.worktrees.length ? "hasWorktrees" : ""}`}>
                    {group.chats.map((chat) => renderChatRow(chat))}
                    {group.worktrees.map((worktree) => {
                      const worktreeCollapsed = !search && collapsedWorktreeKeys.has(worktree.key);
                      const canCreateWorktreeChat = /^task-[A-Za-z0-9_-]+$/.test(worktree.rootTaskId);
                      return (
                        <section className="chatWorktree" key={worktree.key}>
                          <div className="chatWorktreeHeader">
                            <button
                              className="chatWorktreeToggle"
                              type="button"
                              onClick={() => toggleWorktreeGroup(worktree.key)}
                              aria-expanded={!worktreeCollapsed}
                              title={worktree.path}
                            >
                              <ChevronDown className={worktreeCollapsed ? "collapsed" : ""} size={13} />
                              <GitBranch size={13} />
                              <span>
                                <strong>{worktreeTitle(worktree)}</strong>
                              </span>
                            </button>
                            <button
                              className="chatWorktreeNewButton"
                              type="button"
                              onClick={() => void newChatForWorktree(group, worktree)}
                              disabled={!canCreateWorktreeChat}
                              title={`Start a new chat in "${worktreeTitle(worktree)}"`}
                            >
                              <SquarePen size={13} />
                            </button>
                          </div>
                          {!worktreeCollapsed ? (
                            <div className="chatWorktreeChats">
                              {worktree.chats.map((chat) => renderChatRow(chat))}
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
                    {!group.chats.length && !group.worktrees.length ? <div className="chatProjectEmpty">No chats yet.</div> : null}
                  </div>
                ) : null}
              </section>
            );
          })
        ) : (
          <div className="workspaceArchiveEmpty">
            <CircleDashed size={17} />
            <strong>{search ? "No matching chats" : "A fresh space for your work"}</strong>
            {!search && <span>Your conversations will appear here.</span>}
          </div>
        )}
      </div>
    </section>
  );
}
