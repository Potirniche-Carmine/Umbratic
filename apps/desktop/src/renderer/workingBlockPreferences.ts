import { useSyncExternalStore } from "react";

const storageKey = "umbratic-auto-expand-working-blocks";
let autoExpand = false;
try {
  autoExpand = window.localStorage.getItem(storageKey) === "true";
} catch { /* Keep the default when storage is unavailable. */ }

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setAutoExpandWorkingBlocks(next: boolean): void {
  if (autoExpand === next) return;
  autoExpand = next;
  try {
    window.localStorage.setItem(storageKey, String(next));
  } catch { /* Keep the preference for this session. */ }
  for (const listener of listeners) listener();
}

export function useAutoExpandWorkingBlocks(): boolean {
  return useSyncExternalStore(subscribe, () => autoExpand, () => autoExpand);
}
