/**
 * The app's keyboard shortcuts, in one place.
 *
 * One list is the whole point: the handler that runs a shortcut, the tooltip
 * that advertises it, and the settings page that documents it all read these
 * rows. A chord cannot be added without appearing where the user looks for it,
 * and no surface can promise a chord that no longer fires.
 *
 * The chords follow the conventions people already have from other tools —
 * ⌘N for a new one of the thing, ⌘, for settings, ⌘. to cancel, ⌘/ for the
 * shortcut list — because the best keyboard shortcut is the one somebody
 * already knows. Modifiers are written for the machine reading them: ⌘ on a
 * Mac, Ctrl everywhere else, and the same binding covers both.
 */

import { useSyncExternalStore } from "react";

export type ShortcutId =
  | "dictation.toggle"
  | "chat.new"
  | "chat.jump"
  | "chat.delete"
  | "app.settings"
  | "app.shortcuts"
  | "review.toggle"
  | "composer.focus"
  | "run.stop"
  | "composer.send"
  | "composer.newline"
  | "composer.mention"
  | "dialog.dismiss";

export type ShortcutBinding = {
  /** `event.key`, compared case-insensitively. */
  key: string;
  /** Command on macOS, Control elsewhere. Nearly always what you want. */
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutSection = "Chats and panels" | "Composer" | "Dictation" | "Running" | "Windows and dialogs";

export type ShortcutDefinition = {
  id: ShortcutId;
  section: ShortcutSection;
  label: string;
  detail: string;
  /**
   * Absent for rows that document a key the browser or a focused control
   * already handles. Those are reference only: nothing here installs them, so
   * nothing here can claim to.
   */
  binding?: ShortcutBinding;
  /** A chord shown as text when it is a key the binding cannot express. */
  display?: string[];
  /**
   * Prefixes a `display` chord with the primary modifier, spelled for the
   * machine reading it. A reference row that involves ⌘ or Ctrl cannot write
   * the modifier into `display` itself without naming the wrong one on half the
   * machines that read it.
   */
  displayPrimary?: boolean;
};

/**
 * The chords as shipped. What is actually in force is `activeShortcuts()`,
 * which is this list with the user's own bindings laid over it.
 */
export const shortcuts: readonly ShortcutDefinition[] = [
  {
    id: "chat.new",
    section: "Chats and panels",
    label: "New chat",
    detail: "Saves the draft you are on and starts an empty one.",
    binding: { key: "n", primary: true },
  },
  {
    id: "chat.jump",
    section: "Chats and panels",
    // Nine slots because there are nine number keys worth reaching for without
    // looking. A tenth chat is a click away, and 0 as "the tenth" is a rule
    // nobody remembers.
    label: "Jump to a chat",
    detail: "Hold the modifier to number the first nine chats in the sidebar, then press that number to open one.",
    display: ["1"],
    displayPrimary: true,
  },
  {
    id: "chat.delete",
    section: "Chats and panels",
    label: "Delete this chat",
    // Backspace with both modifiers, the way the Finder and every mail client
    // spell "throw this away" — and never Backspace alone, which is a key the
    // prompt box needs far more often than the sidebar does. The chord asks
    // before it deletes: the same confirmation the trash button raises.
    detail: "Asks before deleting the chat you are in.",
    binding: { key: "Backspace", primary: true, shift: true },
  },
  {
    id: "review.toggle",
    section: "Chats and panels",
    label: "Show or hide review",
    detail: "Opens the review panel on the right, and closes it again.",
    binding: { key: "r", primary: true, shift: true },
  },
  {
    id: "app.settings",
    section: "Chats and panels",
    label: "Settings",
    // The comma is where every desktop app of the last fifteen years has put
    // its settings, so it is the one chord nobody has to be told.
    detail: "Opens Settings on the section you were last in.",
    binding: { key: ",", primary: true },
  },
  {
    id: "app.shortcuts",
    section: "Chats and panels",
    label: "Keyboard shortcuts",
    detail: "Opens this list.",
    binding: { key: "/", primary: true },
  },
  {
    id: "composer.focus",
    section: "Composer",
    label: "Jump to the prompt",
    detail: "Puts the cursor back in the prompt box from anywhere in the window.",
    binding: { key: "l", primary: true },
  },
  {
    id: "composer.send",
    section: "Composer",
    label: "Send the prompt",
    detail: "Queues the message instead when a run is already going.",
    display: ["Enter"],
  },
  {
    id: "composer.newline",
    section: "Composer",
    label: "New line",
    detail: "Continues a numbered or bulleted list when you are in one.",
    display: ["Shift", "Enter"],
  },
  {
    id: "composer.mention",
    section: "Composer",
    label: "Attach a file or run a skill",
    detail: "Type @ for files and folders or / for skills, then the arrow keys to choose and Enter to insert.",
    display: ["@", "/"],
  },
  {
    id: "dictation.toggle",
    section: "Dictation",
    label: "Start or stop dictation",
    detail: "Opens the microphone and closes it again. The same key does both, so there is nothing to remember about which state you are in.",
    binding: { key: "d", primary: true },
  },
  {
    id: "run.stop",
    section: "Running",
    label: "Stop the run",
    // The Mac's own cancel chord, and the one ChatGPT and friends adopted for
    // exactly this. Esc is not free here: it closes the menu or dialog in
    // front, and a key that sometimes stops a run and sometimes closes a
    // popover is a key nobody trusts mid-run.
    detail: "Interrupts the model where it is. Anything already written stays.",
    binding: { key: ".", primary: true },
  },
  {
    id: "dialog.dismiss",
    section: "Windows and dialogs",
    label: "Close what is open",
    detail: "Closes the menu, panel, or dialog in front — one layer per press.",
    display: ["Esc"],
  },
];

/**
 * The bindings the user has changed, by id.
 *
 * Only differences are stored, never the whole table. A release that moves a
 * default has to move it for everyone who never touched that row, and a stored
 * copy of every chord would quietly pin all of them to whatever shipped the day
 * the file was written.
 */
export type ShortcutOverrides = Partial<Record<ShortcutId, ShortcutBinding>>;

/**
 * What is in force, and who to tell when it changes.
 *
 * A module-level store rather than context: the key listener, every tooltip,
 * and the settings page all ask the same question from very different places in
 * the tree, and threading a provider through them would mean every control that
 * merely mentions a chord has to be handed one.
 */
let overrides: ShortcutOverrides = {};
let active: readonly ShortcutDefinition[] = shortcuts;
const listeners = new Set<() => void>();

/** The rows with the user's own bindings laid over the shipped ones. */
export function activeShortcuts(): readonly ShortcutDefinition[] {
  return active;
}

/** The user's changes, as they are stored. */
export function shortcutOverrides(): ShortcutOverrides {
  return overrides;
}

/**
 * Puts a set of user bindings in force, replacing whatever was there.
 *
 * Unknown ids and unusable chords are dropped rather than kept: they can only
 * come from a stored file written by another version of this table, and a
 * binding nothing can dispatch is not a binding.
 */
export function setShortcutOverrides(next: ShortcutOverrides): void {
  const cleaned: ShortcutOverrides = {};
  for (const [id, binding] of Object.entries(next)) {
    const definition = shortcuts.find((row) => row.id === id);
    if (!definition?.binding || !binding || !usableBinding(binding)) continue;
    cleaned[definition.id] = normalizedBinding(binding);
  }
  overrides = cleaned;
  active = shortcuts.map((row) => {
    const override = row.binding ? cleaned[row.id] : undefined;
    return override ? { ...row, binding: override } : row;
  });
  for (const listener of listeners) listener();
}

export function subscribeToShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A chord anything is allowed to be bound to.
 *
 * A modifier is required, and that is not a matter of taste: the listener runs
 * on capture, ahead of the prompt box, so a bare letter would fire every time
 * somebody typed it into a message rather than only when they meant it.
 */
export function usableBinding(binding: ShortcutBinding): boolean {
  if (!binding.key || binding.key.length > 20) return false;
  if (!binding.primary && !binding.alt) return false;
  // Modifier keys are not chords in their own right, and Escape is how the
  // recorder itself is cancelled.
  return !["shift", "control", "alt", "meta", "escape", "dead", "unidentified"].includes(binding.key.toLowerCase());
}

function normalizedBinding(binding: ShortcutBinding): ShortcutBinding {
  return {
    key: binding.key.length === 1 ? binding.key.toLowerCase() : binding.key,
    ...(binding.primary ? { primary: true } : {}),
    ...(binding.shift ? { shift: true } : {}),
    ...(binding.alt ? { alt: true } : {}),
  };
}

/** Whether two chords are the same chord, and so cannot both be installed. */
export function sameBinding(left: ShortcutBinding, right: ShortcutBinding): boolean {
  return left.key.toLowerCase() === right.key.toLowerCase()
    && !!left.primary === !!right.primary
    && !!left.shift === !!right.shift
    && !!left.alt === !!right.alt;
}

/**
 * The shortcut a chord is already taken by, if any. Two rows on one chord means
 * one of them silently never fires, so the editor refuses rather than allows it.
 */
export function conflictingShortcut(id: ShortcutId, binding: ShortcutBinding): ShortcutDefinition | null {
  return active.find((row) => row.id !== id && row.binding && sameBinding(row.binding, binding)) ?? null;
}

/**
 * The chord a key press would be recorded as, or null if it is not one.
 *
 * Modifier presses on their own are not chords, which is what lets the recorder
 * sit open while somebody holds Command and decides what to press with it.
 */
export function bindingFromEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = isMacPlatform(),
): ShortcutBinding | null {
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  // The other platform's modifier is never part of a chord here, so a chord
  // recorded with it held could never be matched back.
  if (secondary) return null;
  const binding = normalizedBinding({
    key: event.key,
    primary,
    shift: event.shiftKey,
    alt: event.altKey,
  });
  return usableBinding(binding) ? binding : null;
}

/** The chord that opens and closes the microphone. Named for the composer. */
export function dictationToggleShortcut(): ShortcutBinding {
  return shortcutById("dictation.toggle").binding as ShortcutBinding;
}

/**
 * The chord a row shipped with, which is what resetting one means. Read off the
 * shipped table rather than the active one, which is where the change to be
 * undone already is.
 */
export function defaultShortcutBinding(id: ShortcutId): ShortcutBinding | null {
  return shortcuts.find((row) => row.id === id)?.binding ?? null;
}

export function shortcutById(id: ShortcutId): ShortcutDefinition {
  const found = active.find((shortcut) => shortcut.id === id);
  if (!found) throw new Error(`Unknown shortcut: ${id}`);
  return found;
}

/** Whether this machine spells the primary modifier ⌘ rather than Ctrl. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

/**
 * Whether a key event is this chord.
 *
 * Exact on every modifier, not just the ones the binding names: a shortcut that
 * fired on Ctrl+Shift+K as well as Ctrl+K would swallow chords it was never
 * given, including ones the user's own OS has assigned.
 */
export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding, mac = isMacPlatform()): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  if (primary !== !!binding.primary) return false;
  // The other platform's modifier is never part of a chord here, so holding it
  // means this is some other shortcut.
  if (secondary) return false;
  if (event.shiftKey !== !!binding.shift) return false;
  if (event.altKey !== !!binding.alt) return false;
  return true;
}

/** The shortcut this key event is, if it is one the app installs. */
export function shortcutForEvent(event: KeyboardEvent, mac = isMacPlatform()): ShortcutDefinition | null {
  return active.find((shortcut) => shortcut.binding && matchesShortcut(event, shortcut.binding, mac)) ?? null;
}

/** How many chats the number keys reach. The `chat.jump` row documents them. */
export const chatJumpLimit = 9;

/**
 * The chat position a key press is asking for, or null when it is asking for
 * something else.
 *
 * Deliberately not nine rows in the table above: a row binds one chord to one
 * action, and this is one gesture that means "the nth chat" for whatever the
 * sidebar is showing. It lives here anyway so the platform rule — ⌘ on a Mac,
 * Ctrl everywhere else, never both — is written in exactly one place.
 */
export function chatJumpFromEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = isMacPlatform(),
): number | null {
  if (!chatJumpModifierHeld(event, mac)) return null;
  return /^[1-9]$/.test(event.key) ? Number(event.key) : null;
}

/**
 * Whether the modifier that offers the numbers is down.
 *
 * Exact on the other modifiers, because this is what puts the badges on the
 * rows: ⌥⌘1 is somebody else's shortcut, and numbering the sidebar for it would
 * promise a jump that never comes.
 */
export function chatJumpModifierHeld(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = isMacPlatform(),
): boolean {
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  return primary && !secondary && !event.shiftKey && !event.altKey;
}

/**
 * The chord as separate keys, for a row of <kbd>s.
 *
 * Mac modifiers are their glyphs — ⌘ ⌥ ⇧ — because that is what is printed on
 * the keys themselves; everywhere else they are words, for the same reason.
 */
export function shortcutKeys(definition: ShortcutDefinition, mac = isMacPlatform()): string[] {
  if (definition.display) {
    return definition.displayPrimary ? [mac ? "⌘" : "Ctrl", ...definition.display] : definition.display;
  }
  const binding = definition.binding;
  if (!binding) return [];
  const keys: string[] = [];
  if (binding.primary) keys.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) keys.push(mac ? "⌥" : "Alt");
  if (binding.shift) keys.push(mac ? "⇧" : "Shift");
  keys.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return keys;
}

/** The chord on one line, for a tooltip. "⌘D" on a Mac, "Ctrl+D" elsewhere. */
export function shortcutLabel(definition: ShortcutDefinition, mac = isMacPlatform()): string {
  return shortcutKeys(definition, mac).join(mac ? "" : "+");
}

/**
 * A control's tooltip with its chord after it, the way every app that expects
 * to be used twice writes one. A shortcut nobody is told about is a shortcut
 * nobody uses, and the button it duplicates is where someone is already looking.
 */
export function titleWithShortcut(label: string, id: ShortcutId, mac = isMacPlatform()): string {
  const chord = shortcutLabel(shortcutById(id), mac);
  return chord ? `${label} (${chord})` : label;
}

export function shortcutSections(): Array<{ section: ShortcutSection; rows: ShortcutDefinition[] }> {
  const order: ShortcutSection[] = ["Chats and panels", "Composer", "Dictation", "Running", "Windows and dialogs"];
  return order
    .map((section) => ({ section, rows: active.filter((row) => row.section === section) }))
    .filter((group) => group.rows.length > 0);
}

/**
 * Re-renders the caller whenever the bindings change.
 *
 * Every surface that prints a chord — the tooltips especially — has to redraw
 * the moment one is rebound, or the app spends the rest of the session telling
 * people to press a key that no longer does anything.
 */
export function useShortcuts(): readonly ShortcutDefinition[] {
  return useSyncExternalStore(subscribeToShortcuts, activeShortcuts, activeShortcuts);
}
