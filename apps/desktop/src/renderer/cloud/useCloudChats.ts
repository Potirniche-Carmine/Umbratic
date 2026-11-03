import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { CloudApi, CloudChatRecord, CloudImage, CloudProvider, CloudWorkspace, CloudWorkspaceInput } from "../../shared/cloud";
import type { ReviewCommentDraft } from "../review/reviewComments";

type Draft = { prompt: string; images: CloudImage[]; feedback: ReviewCommentDraft[] };
const emptyDraft = (): Draft => ({ prompt: "", images: [], feedback: [] });
export function cloudChatSummary(workspace: CloudWorkspace): CloudChatRecord {
  return { key: workspace.key, provider: workspace.provider, state: workspace.state,
    title: workspace.entries.find(entry => entry.kind === "instruction")?.text.trim().replace(/\s+/g, " ").slice(0, 100) || "New chat",
    paths: workspace.paths || [workspace.path], repositoryIds: workspace.repositoryIds, updatedAt: workspace.lastActiveAt || workspace.entries.at(-1)?.at || "" };
}

/** Each provider owns its own selection and every conversation owns its draft. */
export function useCloudChats(api: CloudApi, provider: CloudProvider, defaultIds: string[], onError: (message: string) => void) {
  const [workspace, setWorkspace] = useState<CloudWorkspace | null>(null);
  const [chats, setChats] = useState<CloudChatRecord[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const drafts = useRef(new Map<string, Draft>());
  const current = useRef({ workspace, draft }); current.current = { workspace, draft };
  const generation = useRef(0);
  const error = useRef(onError); error.current = onError;
  const initialIds = useRef(defaultIds);
  const storageKey = `umbratic.active-chat.${provider}`;
  function updateList(next: CloudWorkspace) {
    if (!next.chatId && !next.entries.length) { setChats(existing => existing.filter(chat => chat.key !== next.key)); return; }
    const row = cloudChatSummary(next);
    setChats(existing => [row, ...existing.filter(chat => chat.key !== row.key)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  const open = useCallback(async (input: CloudWorkspaceInput, create = false, carryDraft = false) => {
    const request = ++generation.current;
    const previous = current.current;
    if (previous.workspace) drafts.current.set(previous.workspace.key, previous.draft);
    setLoading(true);
    try {
      const next = await (create ? api.createCloudChat(input) : api.getCloudWorkspace(input));
      if (request !== generation.current) return;
      const nextDraft = drafts.current.get(next.key) || (carryDraft ? previous.draft : emptyDraft());
      current.current = { workspace: next, draft: nextDraft };
      setWorkspace(next); setDraft(nextDraft); updateList(next);
      try { localStorage.setItem(storageKey, next.key); } catch { /* In-memory selection remains usable. */ }
      if (carryDraft && previous.workspace?.chatId && !previous.workspace.entries.length && previous.workspace.key !== next.key) {
        const previousKey = previous.workspace.key;
        await api.deleteCloudChat({ key: previousKey, provider: previous.workspace.provider });
        drafts.current.delete(previousKey);
        setChats(existing => existing.filter(chat => chat.key !== previousKey));
      }
    } catch (cause) { if (request === generation.current) error.current(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [api, storageKey]);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onCloudWorkspace(next => {
      if (next.provider !== provider) return;
      updateList(next);
      if (next.key === current.current.workspace?.key) { current.current.workspace = next; setWorkspace(next); }
    });
    void api.listCloudChats({ provider }).then(async rows => {
      if (cancelled) return;
      setChats(rows);
      let key: string | null = null;
      try { key = localStorage.getItem(storageKey); } catch { /* Use the most recent chat. */ }
      const selected = rows.find(row => row.key === key) || rows[0];
      await open(selected ? { provider, key: selected.key } : { provider, repositoryIds: initialIds.current }, !selected);
    }).catch(cause => { if (!cancelled) { error.current(String(cause)); setLoading(false); } });
    return () => { cancelled = true; generation.current++; unsubscribe(); };
  }, [api, provider, open, storageKey]);
  async function remove(keys: string | string[]) {
    const deleted = new Set<string>();
    try {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        await api.deleteCloudChat({ key, provider }); deleted.add(key); drafts.current.delete(key);
      }
    } finally {
      const remaining = chats.filter(chat => !deleted.has(chat.key)); setChats(remaining);
      if (current.current.workspace && deleted.has(current.current.workspace.key)) {
        current.current = { workspace: null, draft: emptyDraft() }; setWorkspace(null); setDraft(emptyDraft());
        await open(remaining[0] ? { provider, key: remaining[0].key } : { provider, repositoryIds: initialIds.current }, !remaining.length);
      }
    }
  }
  function field<K extends keyof Draft>(key: K) {
    return (value: SetStateAction<Draft[K]>) => setDraft(previous => ({ ...previous, [key]: typeof value === "function" ? (value as (previous: Draft[K]) => Draft[K])(previous[key]) : value }));
  }
  return { workspace, setWorkspace, chats, loading, open, remove, drafts,
    ...draft, setPrompt: field("prompt"), setImages: field("images"), setFeedback: field("feedback") };
}
