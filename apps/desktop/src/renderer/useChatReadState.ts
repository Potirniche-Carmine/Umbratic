import { useEffect, useState } from "react";
import type { WorkspaceActivity } from "./ChatActivityIndicator";

type ChatReadRecord = { id: string; updatedAt: string; state: WorkspaceActivity };

function readRevisions(key: string): Map<string, string> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) || "[]");
    if (Array.isArray(saved)) return new Map(saved.filter((entry): entry is [string, string] =>
      Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string")));
  } catch { /* Read state still works when storage is unavailable. */ }
  return new Map();
}

function foreground() {
  return document.visibilityState !== "hidden" && (document.hasFocus?.() ?? true);
}

/** A completed reply stays unread until its chat is visible in the focused window. */
export function useChatReadState(scope: string, chats: readonly ChatReadRecord[], activeId: string | null | undefined, visible: boolean): Set<string> {
  const storageKey = `umbratic.read-chats.${scope}`;
  const [read, setRead] = useState(() => readRevisions(storageKey));
  const [focused, setFocused] = useState(foreground);
  useEffect(() => {
    const update = () => setFocused(foreground());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const selected = visible && focused ? chats.find(chat => chat.id === activeId && chat.state === "idle") : undefined;
  const selectedId = selected?.id;
  const revision = selected?.updatedAt;
  useEffect(() => {
    if (selectedId === undefined || revision === undefined || read.get(selectedId) === revision) return;
    const next = new Map(read).set(selectedId, revision);
    setRead(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Keep the in-memory read state. */ }
  }, [selectedId, revision, read, storageKey]);
  return new Set(chats.filter(chat => chat.state === "idle" && chat.id !== selectedId && read.get(chat.id) !== chat.updatedAt).map(chat => chat.id));
}
