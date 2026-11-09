import { useEffect, useRef } from "react";
import { shortcutAvailable, shortcutForEvent, type ShortcutId, type ShortcutMode } from "./keyboardShortcuts";
import { shortcutOverlayOpen } from "./useChatJumpShortcuts";

export type WorkspaceShortcutActions = Partial<Record<ShortcutId, () => void>>;
type Options = { blocked: boolean; mode: ShortcutMode; allowSettings?: boolean; onEscape?(): void };

export function dispatchWorkspaceShortcut(event: KeyboardEvent, actions: WorkspaceShortcutActions, options: Options): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  const shortcut = shortcutForEvent(event);
  if (!shortcut || !shortcutAvailable(shortcut.id, options.mode)) return false;
  const settingsAction = shortcut.id === "app.settings" || shortcut.id === "app.shortcuts";
  if (options.blocked && !(options.allowSettings && settingsAction)) return false;
  const action = actions[shortcut.id];
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}

/** One dispatcher for every workspace; Settings owns its own toggle even over a provider. */
export function useWorkspaceShortcuts(actions: WorkspaceShortcutActions, options: Options) {
  const state = useRef({ actions, options });
  state.current = { actions, options };
  useEffect(() => {
    const runShortcut = (event: KeyboardEvent) => {
      const { actions, options } = state.current;
      dispatchWorkspaceShortcut(event, actions, { ...options, blocked: options.blocked || shortcutOverlayOpen() });
    };
    // Escape bubbles so a focused menu or composer can dismiss its own layer
    // before the workspace closes the review panel behind it.
    const dismiss = (event: KeyboardEvent) => {
      const { options } = state.current;
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing || options.blocked || shortcutOverlayOpen()) return;
      options.onEscape?.();
    };
    document.addEventListener("keydown", runShortcut, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("keydown", runShortcut, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, []);
}
