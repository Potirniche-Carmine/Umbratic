import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";

import {
  bindingFromEvent,
  conflictingShortcut,
  defaultShortcutBinding,
  isMacPlatform,
  sameBinding,
  setShortcutOverrides,
  shortcutKeys,
  shortcutOverrides,
  shortcutSections,
  useShortcuts,
  type ShortcutBinding,
  type ShortcutDefinition,
  type ShortcutId,
  type ShortcutOverrides,
} from "./keyboardShortcuts";
import type { DesktopApi } from "../shared/desktopApi";

/**
 * Every key the app answers to, and the place they are changed.
 *
 * The rows come from the same table the key listener dispatches on, so this
 * page cannot describe a chord that does not fire — and now cannot promise one
 * either: a change is in force the moment it is recorded, before it is written
 * to disk, because a shortcut that waits for a round trip to start working is
 * a shortcut the user presses twice.
 *
 * The modifiers are drawn for the machine they are read on — ⌘ on a Mac, Ctrl
 * everywhere else — because a shortcut printed with the wrong modifier is a
 * shortcut nobody can press. The stored binding is the same either way, so a
 * user who moves between the two machines does not rebind anything twice.
 */
export function KeyboardSettingsPanel({ api }: { api: DesktopApi }) {
  const mac = isMacPlatform();
  useShortcuts();
  /** The row currently listening for a chord, or null. */
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  /** Why the last recorded chord was refused. Cleared by the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const recordingRef = useRef<ShortcutId | null>(null);
  recordingRef.current = recording;

  const save = useCallback((next: ShortcutOverrides) => {
    // In force first, written second. The write can fail — a locked database, a
    // disk that is full — and a key that works until the next launch is a
    // better answer to that than one that refuses to work now.
    setShortcutOverrides(next);
    void api.saveKeyBindings(next as Record<string, ShortcutBinding>).catch(() => undefined);
  }, [api]);

  const record = useCallback((id: ShortcutId, binding: ShortcutBinding) => {
    const taken = conflictingShortcut(id, binding);
    if (taken) {
      // Two rows on one chord means one of them silently never fires, so the
      // editor names the one already holding it rather than taking it away.
      setRefusal(`That chord already belongs to "${taken.label}".`);
      return;
    }
    setRefusal(null);
    setRecording(null);
    const shipped = defaultShortcutBinding(id);
    const next = { ...shortcutOverrides() };
    // A chord recorded back onto its own default is not an override; storing it
    // would pin the row to today's default forever.
    if (shipped && sameBinding(shipped, binding)) delete next[id];
    else next[id] = binding;
    save(next);
  }, [save]);

  // The recorder listens on the window, on capture, for the same reason the app
  // does: the button that opened it has focus, and a chord like ⌘W would be the
  // window's before it were ever this page's.
  useEffect(() => {
    if (!recording) return;
    const listen = (event: KeyboardEvent) => {
      const id = recordingRef.current;
      if (!id || event.repeat || event.isComposing) return;
      // Modifiers alone are not chords: this is what lets the recorder sit open
      // while somebody holds Command and decides what to press with it.
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setRefusal(null);
        return;
      }
      const binding = bindingFromEvent(event, mac);
      if (!binding) {
        // The listener runs ahead of the prompt box, so a chord with no
        // modifier would fire every time the key was typed into a message.
        setRefusal(mac ? "Hold ⌘ or ⌥ as part of the chord." : "Hold Ctrl or Alt as part of the chord.");
        return;
      }
      record(id, binding);
    };
    window.addEventListener("keydown", listen, true);
    return () => window.removeEventListener("keydown", listen, true);
  }, [mac, record, recording]);

  const reset = useCallback((id: ShortcutId) => {
    const next = { ...shortcutOverrides() };
    delete next[id];
    setRefusal(null);
    save(next);
  }, [save]);

  const resetAll = useCallback(() => {
    setRecording(null);
    setRefusal(null);
    save({});
  }, [save]);

  const changed = Object.keys(shortcutOverrides()).length;

  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Keyboard</h3>
        <p>The keys this app answers to. Press a chord to change one.</p>
      </div>

      {shortcutSections().map((group) => (
        <div className="settingsGroup" key={group.section}>
          <h4>{group.section}</h4>
          <ul className="shortcutList">
            {group.rows.map((row) => (
              <ShortcutRow
                key={row.id}
                row={row}
                mac={mac}
                recording={recording === row.id}
                refusal={recording === row.id ? refusal : null}
                overridden={!!shortcutOverrides()[row.id]}
                onRecord={() => { setRefusal(null); setRecording(row.id); }}
                onCancel={() => { setRefusal(null); setRecording(null); }}
                onReset={() => reset(row.id)}
              />
            ))}
          </ul>
        </div>
      ))}

      <div className="shortcutFooter">
        {/* Rows the app does not install are marked rather than quietly inert,
            because a row that refuses to be pressed and never says why reads as
            a broken control rather than as a key somebody else owns. */}
        <p className="settingsMessage">
          Rows without a button are keys the window or the field you are in already handles.
        </p>
        <button className="settingsInlineButton" type="button" onClick={resetAll} disabled={changed === 0}>
          <RotateCcw size={13} aria-hidden="true" />
          <span>Reset all</span>
        </button>
      </div>
    </div>
  );
}

function ShortcutRow({
  row,
  mac,
  recording,
  refusal,
  overridden,
  onRecord,
  onCancel,
  onReset,
}: {
  row: ShortcutDefinition;
  mac: boolean;
  recording: boolean;
  refusal: string | null;
  overridden: boolean;
  onRecord(): void;
  onCancel(): void;
  onReset(): void;
}) {
  const editable = !!row.binding;
  const keys = shortcutKeys(row, mac);
  return (
    <li className={`shortcutRow ${recording ? "isRecording" : ""}`}>
      <div className="shortcutText">
        <strong>{row.label}</strong>
        <span>{refusal ?? row.detail}</span>
      </div>
      {editable ? (
        <div className="shortcutEdit">
          {overridden && !recording ? (
            <button className="shortcutResetButton" type="button" onClick={onReset} aria-label={`Reset ${row.label} to its default`}>
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          ) : null}
          {/* The chord itself is the button. A separate "Change" beside it is a
              second thing to aim at for one action, and the keycaps are already
              where the eye is. */}
          <button
            className={`shortcutKeys shortcutKeysButton ${refusal ? "isRefused" : ""}`}
            type="button"
            onClick={recording ? onCancel : onRecord}
            aria-label={recording ? `Cancel changing ${row.label}` : `Change the chord for ${row.label}`}
          >
            {recording ? (
              <span className="shortcutListening">Press a chord…</span>
            ) : (
              keys.map((key, index) => <kbd key={`${row.id}:${index}`}>{key}</kbd>)
            )}
          </button>
          {recording ? (
            <button className="shortcutResetButton" type="button" onClick={onCancel} aria-label="Stop recording">
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="shortcutKeys">
          {keys.map((key, index) => <kbd key={`${row.id}:${index}`}>{key}</kbd>)}
        </div>
      )}
    </li>
  );
}
