import { useEffect, useRef } from "react";
import { shortcutAvailable, shortcutForEvent, type ShortcutId } from "../keyboardShortcuts";

export type CloudShortcutActions = Partial<Record<ShortcutId, () => void>>;

export function dispatchCloudShortcut(event: KeyboardEvent, actions: CloudShortcutActions, blocked: boolean): boolean {
  if (blocked || event.defaultPrevented || event.repeat || event.isComposing) return false;
  const shortcut = shortcutForEvent(event);
  const action = shortcut && shortcutAvailable(shortcut.id, "cloud") && actions[shortcut.id];
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}

/** Uses the same bindings as Private, with no actions behind a dialog or menu. */
export function useCloudShortcuts(actions: CloudShortcutActions, blocked: boolean, dismissReview: () => void) {
  const state = useRef({ actions, blocked, dismissReview });
  state.current = { actions, blocked, dismissReview };
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const current = state.current;
      const covered = current.blocked || Array.from(document.querySelectorAll("dialog[open], :popover-open:not([role=tooltip]), [aria-modal='true']")).some(element => element.checkVisibility());
      if (dispatchCloudShortcut(event, current.actions, covered)) return;
      if (!covered && !event.defaultPrevented && !event.repeat && !event.isComposing && event.key === "Escape") current.dismissReview();
    };
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, []);
}
