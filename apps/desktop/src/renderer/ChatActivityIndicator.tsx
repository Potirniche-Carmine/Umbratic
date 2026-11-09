import React from "react";
import type { TaskState } from "../shared/desktopApi";

export type WorkspaceActivity = "idle" | "running" | "waiting";

export function localChatActivity(state?: TaskState, awaitingPermission = false): WorkspaceActivity {
  if (awaitingPermission || state === "awaiting_worktree_approval" || state === "failed") return "waiting";
  return state === "running" || state === "approving" ? "running" : "idle";
}

/** A single status treatment for chat rows and provider navigation. */
export function ChatActivityIndicator({ state, unread = false, label, detail }: { state: WorkspaceActivity; unread?: boolean; label?: string; detail?: string }) {
  if (state === "idle" && !unread) return null;
  const description = label ?? (state === "running" ? "Working" : state === "waiting" ? "Needs your attention" : "Unread reply");
  return <span className={`workspaceActivity is-${state}`} role="img" aria-label={description} title={detail ? `${description} · ${detail}` : description}>
    {state === "running" ? <><i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/></> : <i aria-hidden="true"/>}
  </span>;
}
