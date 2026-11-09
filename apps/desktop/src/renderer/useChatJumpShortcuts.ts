import { useEffect, useRef, useState } from "react";
import { chatJumpFromEvent, chatJumpLimit, chatJumpModifierHeld } from "./keyboardShortcuts";

export function shortcutOverlayOpen(): boolean {
  return Array.from(document.querySelectorAll("dialog[open], :popover-open:not([role=tooltip]), [aria-modal='true'], [role='menu']"))
    .some(element => element.checkVisibility());
}

/** Shared by every provider: numbers follow visible rows and listen before text inputs. */
export function useChatJumpShortcuts<T>(targets: readonly T[], onSelect: (target: T) => void, blocked: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const state = useRef({ targets, onSelect, blocked });
  state.current = { targets, onSelect, blocked };
  useEffect(() => {
    const sync = (event: KeyboardEvent) => {
      const current = state.current;
      const overlay = shortcutOverlayOpen();
      const covered = current.blocked || overlay;
      // Keep tracking the modifier during a chat load so the badges return as
      // soon as navigation is available, even if Command has not been released.
      setVisible(!overlay && chatJumpModifierHeld(event));
      if (covered || event.type !== "keydown" || event.defaultPrevented || event.repeat || event.isComposing) return;
      const position = chatJumpFromEvent(event);
      const target = position && position <= chatJumpLimit ? current.targets[position - 1] : undefined;
      if (target === undefined) return;
      event.preventDefault();
      current.onSelect(target);
    };
    const clear = () => setVisible(false);
    document.addEventListener("keydown", sync, true);
    document.addEventListener("keyup", sync, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", sync, true);
      document.removeEventListener("keyup", sync, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return visible && !blocked;
}
