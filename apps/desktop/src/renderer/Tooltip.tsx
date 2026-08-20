/**
 * The app's own tooltip.
 *
 * The platform's `title=` was doing this job and doing it badly: it arrives
 * after a second and a half of stillness, it is drawn by the window server in
 * the system's font on the system's yellow, and it cannot hold a row of keycaps.
 * A control that duplicates a chord has to say which chord, and it has to say it
 * in the app's own voice — a tooltip that looks like it came from somewhere else
 * reads as something the app did not mean to show.
 *
 * The trigger is the child element itself, cloned with the handlers on it, so
 * nothing is wrapped: the composer rail and the sidebar are flex layouts where
 * an extra span between a button and its parent changes the spacing around it.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { isMacPlatform, shortcutById, shortcutKeys, useShortcuts, type ShortcutId } from "./keyboardShortcuts";

/**
 * How long the pointer rests before the tooltip appears.
 *
 * Short, because this is a hint about a control the pointer is already on, not
 * a disclosure that has to be earned — but not zero, or every pass across the
 * composer rail flashes three of them on the way somewhere else.
 */
const openDelayMs = 320;

/** Where the tooltip sits relative to its trigger. */
export type TooltipPlacement = "top" | "bottom";

/** The gap between the trigger and the tooltip's near edge. */
const offsetPx = 8;

/** How close to the window edge the tooltip may sit before it is nudged in. */
const marginPx = 8;

type Anchor = { left: number; top: number; placement: TooltipPlacement };

/**
 * Whether focus is currently being moved by Tab.
 *
 * `:focus-visible` on its own is not enough to decide that a focus deserves a
 * tooltip. A modal hands focus back to the control that opened it when it
 * closes, and because the key that closed it was Escape the browser calls that
 * focus visible — which left a tooltip standing over the Settings button with
 * no pointer near it and no blur coming to take it down. Tab is the only focus
 * that is someone arriving at a control and wanting it explained.
 */
let tabbing = false;
let tabbingWatchers = 0;
const noteTabbing = (event: KeyboardEvent) => { tabbing = event.key === "Tab"; };
const clearTabbing = () => { tabbing = false; };

/** The watch above, bound while any tooltip is mounted and not before. */
function useTabbingWatch() {
  useEffect(() => {
    if (tabbingWatchers++ === 0) {
      document.addEventListener("keydown", noteTabbing, true);
      document.addEventListener("pointerdown", clearTabbing, true);
    }
    return () => {
      if (--tabbingWatchers === 0) {
        document.removeEventListener("keydown", noteTabbing, true);
        document.removeEventListener("pointerdown", clearTabbing, true);
      }
    };
  }, []);
}

/**
 * A tooltip on any single element.
 *
 * Pointer and keyboard both raise it, because a control reachable by Tab has to
 * explain itself to the person who reached it that way. It is `aria-describedby`
 * rather than a label: the button already has an accessible name, and a screen
 * reader that reads this instead of that name would announce "New chat ⌘N" as
 * the name of the thing.
 */
export function Tooltip({
  content,
  keys,
  placement = "top",
  disabled,
  children,
}: {
  /** The line of text. Short: this is a hint, not documentation. */
  content: ReactNode;
  /** The chord, one key per cap. Empty for a tooltip that is only words. */
  keys?: readonly string[];
  placement?: TooltipPlacement;
  /** Nothing is shown at all. For controls whose tooltip would be a lie. */
  disabled?: boolean;
  children: ReactElement;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const describedBy = useId();

  useTabbingWatch();

  const hide = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    setAnchor(null);
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Above unless there is no room above, which is where the sidebar's top row
    // and the settings dialog's header both are.
    const above = placement === "top" && rect.top > 64;
    setAnchor({
      left: Math.min(Math.max(rect.left + rect.width / 2, marginPx), window.innerWidth - marginPx),
      top: above ? rect.top - offsetPx : rect.bottom + offsetPx,
      placement: above ? "top" : "bottom",
    });
  }, [placement]);

  const show = useCallback(() => {
    if (disabled) return;
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    openTimerRef.current = setTimeout(place, openDelayMs);
  }, [disabled, place]);

  useEffect(() => hide, [hide]);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  // Anything that moves the trigger takes the tooltip with it — or rather, takes
  // it down: a fixed box left behind by a scroll belongs to nothing on screen.
  useEffect(() => {
    if (!anchor) return;
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    // A press is an answer to the hint, so the hint is finished.
    document.addEventListener("pointerdown", hide, true);
    return () => {
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("pointerdown", hide, true);
    };
  }, [anchor, hide]);

  if (!isValidElement(children)) return children;

  const child = children as ReactElement<Record<string, unknown> & { ref?: Ref<HTMLElement> }>;
  const original = child.props;
  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const forwarded = child.props.ref;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded && typeof forwarded === "object") (forwarded as { current: HTMLElement | null }).current = node;
    },
    // The native tooltip is removed rather than left underneath: two of them,
    // one a beat behind the other, is worse than either alone.
    title: undefined,
    "aria-describedby": anchor ? describedBy : undefined,
    onPointerEnter: (event: React.PointerEvent) => {
      (original.onPointerEnter as ((event: React.PointerEvent) => void) | undefined)?.(event);
      // Touch has no hover, and a tooltip raised by a tap sits over the thing
      // the tap was meant to press.
      if (event.pointerType !== "touch") show();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      (original.onPointerLeave as ((event: React.PointerEvent) => void) | undefined)?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent) => {
      (original.onFocus as ((event: React.FocusEvent) => void) | undefined)?.(event);
      // Only for a focus somebody tabbed into. Clicking a button focuses it
      // too, and a tooltip that appears on every click is a tooltip in the way;
      // so does a dialog closing and giving the focus back.
      if (tabbing && event.target.matches?.(":focus-visible")) place();
    },
    onBlur: (event: React.FocusEvent) => {
      (original.onBlur as ((event: React.FocusEvent) => void) | undefined)?.(event);
      hide();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      (original.onKeyDown as ((event: React.KeyboardEvent) => void) | undefined)?.(event);
      if (event.key === "Escape") hide();
    },
  });

  return (
    <>
      {trigger}
      {anchor ? createPortal(
        <div
          className={`umbraticTooltip is${anchor.placement === "top" ? "Above" : "Below"}`}
          id={describedBy}
          role="tooltip"
          style={{ position: "fixed", left: anchor.left, top: anchor.top }}
        >
          <span className="umbraticTooltipText">{content}</span>
          {keys?.length ? (
            <span className="umbraticTooltipKeys" aria-hidden="true">
              {keys.map((key, index) => <kbd key={`${key}:${index}`}>{key}</kbd>)}
            </span>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/**
 * A tooltip for a control that duplicates a shortcut.
 *
 * The chord is read from the same table the key listener dispatches on and
 * redrawn whenever it is rebound, so a control cannot end up advertising a key
 * that stopped working the moment somebody changed it in Settings.
 */
export function ShortcutTooltip({
  id,
  label,
  placement,
  disabled,
  children,
}: {
  id: ShortcutId;
  /** Overrides the shortcut's own label, for a control that says it differently. */
  label?: string;
  placement?: TooltipPlacement;
  disabled?: boolean;
  children: ReactElement;
}) {
  useShortcuts();
  const definition = shortcutById(id);
  return (
    <Tooltip
      content={label ?? definition.label}
      keys={shortcutKeys(definition, isMacPlatform())}
      placement={placement}
      disabled={disabled}
    >
      {children}
    </Tooltip>
  );
}
