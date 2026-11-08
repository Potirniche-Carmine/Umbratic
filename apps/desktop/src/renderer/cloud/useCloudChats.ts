import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { CloudApi, CloudChatRecord, CloudImage, CloudProvider, CloudWorkspace, CloudWorkspaceInput } from "../../shared/cloud";
import { cloudChatRecord as cloudChatSummary } from "../../shared/cloudChatRecord";
import { chatAfterDeletion } from "../chatListPresentation";
import type { ReviewCommentDraft } from "../review/reviewComments";

type Draft = { prompt: string; images: CloudImage[]; feedback: ReviewCommentDraft[] };
const emptyDraft = (): Draft => ({ prompt: "", images: [], feedback: [] });
const draftKey = (ids: string[]) => `draft:${JSON.stringify([...new Set(ids)].sort())}`;

/** Each provider owns its selection. Unsent chats are composer drafts, never saved conversations. */
export function useCloudChats(api: CloudApi, provider: CloudProvider, defaultIds: string[], onError: (message: string) => void) {
  const [workspace, updateWorkspace] = useState<CloudWorkspace | null>(null);
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [chats, setChats] = useState<CloudChatRecord[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const drafts = useRef(new Map<string, Draft>());
  const current = useRef({ workspace, draft, repositoryIds }); current.current = { workspace, draft, repositoryIds };
  const generation = useRef(0);
  const error = useRef(onError); error.current = onError;
  const initialIds = useRef<string[]>([]);
  const storageKey = `umbratic.active-chat.${provider}`;
  function rememberSelection(key: string) {
    try { localStorage.setItem(storageKey, key); } catch { /* In-memory selection remains usable. */ }
  }
  function updateList(next: CloudWorkspace) {
    if (!next.entries.length) { setChats(existing => existing.filter(chat => chat.key !== next.key)); return; }
    const row = cloudChatSummary(next);
    setChats(existing => [row, ...existing.filter(chat => chat.key !== row.key)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  function setWorkspace(next: CloudWorkspace) {
    if (!current.current.workspace) drafts.current.delete(draftKey(current.current.repositoryIds));
    current.current.workspace = next;
    updateWorkspace(next); updateList(next); rememberSelection(next.key);
  }
  const open = useCallback(async (input: CloudWorkspaceInput, create = false, carryDraft = false) => {
    const request = ++generation.current;
    const previous = current.current;
    const previousKey = previous.workspace?.key ?? draftKey(previous.repositoryIds);
    drafts.current.set(previousKey, previous.draft);
    if (create || !input.key) {
      const ids = input.repositoryIds ?? initialIds.current;
      const nextKey = draftKey(ids);
      const nextDraft = carryDraft ? previous.draft : drafts.current.get(nextKey) ?? emptyDraft();
      if (carryDraft && !previous.workspace && previousKey !== nextKey) drafts.current.delete(previousKey);
      current.current = { workspace: null, draft: nextDraft, repositoryIds: ids };
      updateWorkspace(null); setDraft(nextDraft); setRepositoryIds(ids); setLoading(false);
      rememberSelection("");
      return;
    }
    setLoading(true);
    try {
      const next = await api.getCloudWorkspace(input);
      if (request !== generation.current) return;
      const nextDraft = drafts.current.get(next.key) ?? emptyDraft();
      current.current = { workspace: next, draft: nextDraft, repositoryIds: next.repositoryIds ?? [] };
      updateWorkspace(next); setDraft(nextDraft); setRepositoryIds(next.repositoryIds ?? []); updateList(next);
      rememberSelection(next.key);
    } catch (cause) { if (request === generation.current) error.current(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [api, storageKey]);
  useEffect(() => {
    let cancelled = false;
    const request = generation.current;
    const unsubscribe = api.onCloudWorkspace(next => {
      if (next.provider !== provider) return;
      updateList(next);
      if (next.key === current.current.workspace?.key) { current.current.workspace = next; updateWorkspace(next); }
    });
    void api.listCloudChats({ provider }).then(async rows => {
      if (cancelled || request !== generation.current) return;
      setChats(rows);
      let key: string | null = null;
      try { key = localStorage.getItem(storageKey); } catch { /* Use the most recent chat. */ }
      const selected = key === "" ? undefined : rows.find(row => row.key === key) || rows[0];
      await open(selected ? { provider, key: selected.key } : { provider, repositoryIds: initialIds.current });
    }).catch(cause => { if (!cancelled) { error.current(String(cause)); setLoading(false); } });
    return () => { cancelled = true; generation.current++; unsubscribe(); };
  }, [api, provider, open, storageKey]);
  async function remove(keys: string | string[], visible: readonly CloudChatRecord[] = chats) {
    const deleted = new Set<string>();
    try {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        await api.deleteCloudChat({ key, provider }); deleted.add(key); drafts.current.delete(key);
      }
    } finally {
      setChats(existing => existing.filter(chat => !deleted.has(chat.key)));
      if (current.current.workspace && deleted.has(current.current.workspace.key)) {
        const successor = chatAfterDeletion(visible.map(chat => ({ ...chat, id: chat.key })), current.current.workspace.key, deleted);
        const unsent = drafts.current.get(draftKey(current.current.repositoryIds)) ?? emptyDraft();
        current.current = { workspace: null, draft: unsent, repositoryIds: current.current.repositoryIds };
        updateWorkspace(null); setDraft(unsent);
        await open(successor ? { provider, key: successor.key } : { provider, repositoryIds: current.current.repositoryIds });
      }
    }
  }
  async function reload() {
    const rows = await api.listCloudChats({ provider }); setChats(rows);
    if (current.current.workspace && !rows.some(row => row.key === current.current.workspace!.key)) await open({ provider, repositoryIds: [] }, true);
  }
  useEffect(() => { const refresh = () => { void reload().catch(cause => error.current(String(cause))); }; window.addEventListener("umbratic:projects-change", refresh); return () => window.removeEventListener("umbratic:projects-change", refresh); }, [api, provider, open]);
  function field<K extends keyof Draft>(key: K) {
    return (value: SetStateAction<Draft[K]>) => setDraft(previous => {
      const next = { ...previous, [key]: typeof value === "function" ? (value as (previous: Draft[K]) => Draft[K])(previous[key]) : value };
      current.current.draft = next;
      return next;
    });
  }
  return { workspace, setWorkspace, repositoryIds, chats, loading, open, remove, reload, drafts,
    ...draft, setPrompt: field("prompt"), setImages: field("images"), setFeedback: field("feedback") };
}
