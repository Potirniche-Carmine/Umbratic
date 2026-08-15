import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, GitBranch, Hand, Loader2, Mic, RefreshCw, ShieldCheck, Square } from "lucide-react";

import type { PermissionMode, ReasoningEffort } from "../shared/desktopApi";
import type { DictationDevice, DictationStatus } from "./dictation";
import { ShortcutTooltip, Tooltip } from "./Tooltip";

/**
 * The live microphone level, as four bars.
 *
 * Bars rather than a single meter, and weighted unevenly, because a symmetric
 * shape that rises and falls as one block reads as a progress indicator. This
 * has to read as sound. Silence rests at the minimum height rather than
 * collapsing to nothing — a control that empties itself looks stopped.
 */
function DictationLevelMeter({ level }: { level: number }) {
  const weights = [0.5, 1, 0.72, 0.34];
  return (
    <span className="dictationBars" aria-hidden="true">
      {weights.map((weight, index) => (
        <span
          key={index}
          className="dictationBar"
          style={{ height: `${3 + Math.min(1, Math.max(0, level)) * weight * 13}px` }}
        />
      ))}
    </span>
  );
}

/**
 * Speaks a prompt instead of typing it.
 *
 * The live transcript is drawn by the composer as muted text behind the
 * textarea rather than written into it: a partial is replaced whole on every
 * update, and rewriting the input under a cursor the user may have moved is
 * how dictation eats an edit someone was in the middle of. Only the final
 * transcript is inserted. Neither the partial nor an error appears in this
 * rail — a caption that grows and shrinks beside the buttons moves every
 * control in the row while somebody is talking.
 */
export function DictationControl({
  status,
  enabled,
  devices,
  deviceId,
  onToggle,
  onRequestSetup,
  onSelectDevice,
}: {
  status: DictationStatus;
  /** Whether dictation can actually run right now. */
  enabled: boolean;
  /** Microphones this machine offers. */
  devices: DictationDevice[];
  /** The chosen one, or "" for the system default. */
  deviceId: string;
  onToggle(): void;
  /**
   * Pressed while dictation is off. The composer answers with a line above the
   * prompt box rather than this control answering inline: the offer is wider
   * than the rail can give, and a rail that grows moves every button in it.
   */
  onRequestSetup(): void;
  onSelectDevice(deviceId: string): void;
}) {
  // The button is always here, whether or not dictation is set up. A control
  // that appears only once a hidden precondition is met is a feature nobody
  // discovers; pressing it when it is off explains itself and offers the way in.
  // Where the portalled menu sits, in viewport coordinates. Null is closed.
  const [menuAt, setMenuAt] = useState<{ bottom: number; right: number } | null>(null);
  const deviceRootRef = useRef<HTMLDivElement | null>(null);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!deviceRootRef.current?.contains(target) && !deviceMenuRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    // Any scroll or resize would leave a fixed menu floating away from its
    // trigger, which reads as a menu belonging to nothing.
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuAt]);

  function toggleDeviceMenu() {
    if (menuAt) {
      setMenuAt(null);
      return;
    }
    const rect = deviceRootRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Anchored to the trigger's top-right and opening upward, like every other
    // composer menu. Fixed, and portalled to <body>, because the prompt shell
    // clips its overflow — a menu left inside it is cut off at the shell's edge
    // rather than shown over the conversation.
    setMenuAt({ bottom: window.innerHeight - rect.top + 8, right: Math.max(8, window.innerWidth - rect.right) });
  }
  const recording = status.state === "recording";
  const busy = status.state === "starting" || status.state === "transcribing";
  const label = !enabled
    ? "Set up dictation"
    : recording
      ? "Stop dictation"
      : busy
        ? status.state === "starting" ? "Getting the dictation model ready" : "Transcribing"
        : "Dictate prompt";

  return (
    <>
      <div className={`dictationControl ${recording ? "isRecording" : ""} ${enabled ? "" : "isOff"}`}>
      {/* Only where the key would actually do something: naming a chord beside
          "Transcribing" would offer a shortcut for a state that ignores it. */}
      <ShortcutTooltip id="dictation.toggle" label={label} disabled={busy}>
        <button
          className="dictationButton"
          type="button"
          onClick={() => (enabled ? onToggle() : onRequestSetup())}
          disabled={busy}
          aria-label={label}
          aria-pressed={recording}
        >
          {busy ? (
            <Loader2 className="spin" size={16} />
          ) : recording ? (
            <>
              <DictationLevelMeter level={status.level} />
              {/* The bars say the microphone is live; the square says what
                  pressing does. Swapping one for the other on hover means the
                  button is never ambiguous about either. */}
              <Square className="dictationStopIcon" aria-hidden="true" fill="currentColor" size={11} />
            </>
          ) : (
            <Mic aria-hidden="true" size={16} />
          )}
        </button>
      </ShortcutTooltip>
      {/* Which microphone is a property of the microphone button, so it hangs
          off it rather than living in settings — the moment someone notices the
          wrong input is the moment they are reaching for this control.
          Always rendered, even before the device list has resolved: a control
          that appears a beat after the composer has settled reads as the layout
          still moving. */}
      <div className={`dictationDevices ${menuAt ? "isOpen" : ""}`} ref={deviceRootRef}>
        {/* The app's tooltip here too, though there is no chord to print: the
            two halves are one control, and a system tooltip on one of them
            beside the app's own on the other reads as two different things. */}
        <Tooltip content="Choose microphone" disabled={recording || busy || !!menuAt}>
          <button
            className="dictationDeviceTrigger"
            type="button"
            aria-expanded={!!menuAt}
            aria-haspopup="listbox"
            aria-label="Choose microphone"
            disabled={recording || busy}
            onClick={toggleDeviceMenu}
            onKeyDown={(event) => { if (event.key === "Escape") setMenuAt(null); }}
          >
            <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
              <path fill="currentColor" d="M0.8 0.6h6.4L4 4.4z" />
            </svg>
          </button>
        </Tooltip>
        {menuAt ? createPortal(
          <div
            className="dictationDeviceMenu"
            ref={deviceMenuRef}
            style={{ position: "fixed", bottom: menuAt.bottom, right: menuAt.right }}
            role="listbox"
            aria-label="Microphone"
          >
            {devices.length === 0 ? (
              <p className="dictationDeviceEmpty">No microphones found</p>
            ) : devices.map((device) => (
              <button
                key={device.deviceId}
                type="button"
                role="option"
                aria-selected={device.deviceId === deviceId}
                className={device.deviceId === deviceId ? "active" : ""}
                onClick={() => {
                  setMenuAt(null);
                  onSelectDevice(device.deviceId);
                }}
              >
                {/* The system's own choice is named as such rather than shown as
                    a separate "System default" row, which would have listed the
                    same microphone twice under two names. */}
                {device.isDefault ? <em>Default:</em> : null}
                <span>{device.label}</span>
                {device.deviceId === deviceId ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>,
          document.body,
        ) : null}
      </div>
      </div>
    </>
  );
}

export type ComposerModelOption = {
  id: string;
  label: string;
  /** Whether the model is running. `undefined` in local mode, where the one
   * configured model either answers or the runtime is down as a whole. */
  available?: boolean;
};

const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  off: "No thinking",
  on: "Thinking",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Picks which model answers the next run, and how hard it thinks.
 *
 * One control for both, because effort is a property of the model rather than
 * a peer of it: a second pill beside the name implied it applied to whatever
 * was selected, when in fact most models have no such setting at all. Here the
 * levels are simply part of what the chosen model offers, and models that read
 * no effort show no section.
 *
 * The menu opens upward from its trigger, like every other composer menu, so
 * the control the user pressed is visibly where the menu came from.
 */
export function ComposerModelPicker({
  models,
  selectedId,
  efforts,
  effort,
  disabled,
  disabledReason,
  effortDisabled,
  onOpen,
  onSelect,
  onSelectEffort,
  onManage,
  showThinking = false,
  showThinkingAvailable = false,
  onToggleShowThinking,
}: {
  models: ComposerModelOption[];
  selectedId: string;
  /** The levels the selected model reads. Empty means it reads none. */
  efforts: readonly ReasoningEffort[];
  effort: ReasoningEffort;
  disabled: boolean;
  /** Shown as the trigger's tooltip while disabled — a control that refuses
   * silently reads as broken. */
  disabledReason?: string;
  /** Effort changes restart the local stack, so they wait for a run to end
   * even when switching models does not. */
  effortDisabled?: boolean;
  onOpen?(): void;
  onSelect(id: string): void;
  onSelectEffort(next: ReasoningEffort): void;
  /** Takes the user to where models are downloaded. */
  onManage?(): void;
  /** Live model thinking in the Working block. Off until asked. */
  showThinking?: boolean;
  /** The connected Veil advertised `chat.reasoning_visible`. */
  showThinkingAvailable?: boolean;
  onToggleShowThinking?(next: boolean): void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Which page of the menu is showing. The model list is a step in rather than
  // a list inline: with the effort levels above it, one flat menu would be a
  // wall of rows where only two of them answer the same question.
  const [page, setPage] = useState<"main" | "models">("main");
  const selected = models.find((model) => model.id === selectedId);
  // Nothing downloaded yet is a state the control stays present for. Hiding it
  // leaves the composer with no answer to "what will answer this, and how do I
  // choose one" at exactly the moment the user has not chosen.
  const selectedLabel = selected?.label || selectedId || "Choose a model";
  // Nothing chosen yet: the menu's only useful page is the list of models, and
  // making someone press "Choose a model" and then "Model ›" to reach it is two
  // clicks to answer a question the trigger already asked. With a model chosen
  // the main page is right again — effort is the thing being changed most, and
  // the model is one step away rather than a wall of rows.
  const unchosen = !selected;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Reopen on the main page, never where it was left: a menu that remembers a
  // sub-page reopens somewhere the user did not put it. The exception is a
  // composer with no model yet, which opens straight onto the list — and only
  // once per opening, so pressing Back still gets you out of it.
  const placedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      placedRef.current = false;
      setPage("main");
      return;
    }
    if (placedRef.current || !unchosen || models.length === 0) return;
    // The list is refreshed as the menu opens, so this runs again when it
    // lands rather than only at the moment of the press.
    placedRef.current = true;
    setPage("models");
  }, [models.length, open, unchosen]);

  return (
    <div className={`modelControl ${open ? "isOpen" : ""}`} ref={rootRef}>
      <button
        className="modelTrigger"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={disabled ? disabledReason ?? "" : `Model: ${selectedLabel}`}
        onClick={() => {
          setOpen((current) => {
            if (!current) onOpen?.();
            return !current;
          });
        }}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="modelMenu" role="menu" aria-label="Model">
          {page === "main" ? (
            <>
              {efforts.length > 0 ? (
                <>
                  <p className="modelMenuHeading">Effort</p>
                  {efforts.map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={level === effort}
                      className={`modelMenuRow ${level === effort ? "active" : ""}`}
                      disabled={effortDisabled}
                      onClick={() => {
                        setOpen(false);
                        onSelectEffort(level);
                      }}
                    >
                      <span className="modelName">{reasoningEffortLabels[level]}</span>
                      {level === effort ? <Check size={14} aria-hidden="true" /> : null}
                    </button>
                  ))}
                </>
              ) : null}
              {efforts.length > 0 && showThinkingAvailable && effort !== "off" && onToggleShowThinking ? (
                <label className={`modelMenuCheck ${showThinking ? "isOn" : ""}`}>
                  <input
                    type="checkbox"
                    checked={showThinking}
                    onChange={(event) => onToggleShowThinking(event.target.checked)}
                  />
                  Show thinking
                  <span className="modelMenuCheckBox" aria-hidden="true">
                    <Check size={10} strokeWidth={3.25} />
                  </span>
                </label>
              ) : null}
              <p className="modelMenuHeading">Model</p>
              {models.length === 0 ? (
                <button
                  type="button"
                  className="modelMenuRow modelMenuStep"
                  onClick={() => {
                    setOpen(false);
                    onManage?.();
                  }}
                >
                  <span className="modelName">Download a model…</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="modelMenuRow modelMenuStep"
                  aria-haspopup="menu"
                  onClick={() => setPage("models")}
                >
                  <span className="modelName">{selectedLabel}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="modelMenuRow modelMenuBack"
                onClick={() => setPage("main")}
              >
                <ChevronLeft size={14} aria-hidden="true" />
                <span className="modelName">Model</span>
              </button>
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={model.id === selectedId}
                  className={[
                    "modelMenuRow",
                    model.id === selectedId ? "active" : "",
                    model.available === false ? "isStopped" : "",
                  ].filter(Boolean).join(" ")}
                  title={model.available === false ? "This model is registered but not running" : undefined}
                  onClick={() => {
                    setOpen(false);
                    onSelect(model.id);
                  }}
                >
                  {model.available === undefined ? null : <span className="modelStatusDot" aria-hidden="true" />}
                  <span className="modelName">{model.label}</span>
                  {model.id === selectedId ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              ))}
              {onManage ? (
                <button
                  type="button"
                  className="modelMenuRow modelMenuStep"
                  onClick={() => {
                    setOpen(false);
                    onManage();
                  }}
                >
                  <span className="modelName">Download a model…</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Chooses whether the next run edits the repository in place or in an isolated
 * worktree.
 *
 * A checkbox rather than a two-item menu. The choice is binary and the menu
 * spent a click and a popover restating that: worktree is either on or it is
 * not, and a box that is either ticked or not says so without being opened.
 * It lives here rather than in `main.tsx` for the same reason as the controls
 * above — the composer row is one visual grammar, and keeping its markup
 * together is what keeps it one.
 */
export function WorktreeToggle({
  useWorktree,
  locked,
  disabled,
  onToggle,
}: {
  useWorktree: boolean;
  /** The chat is already running in a worktree, so the choice is behind it. */
  locked: boolean;
  disabled: boolean;
  onToggle(next: boolean): void;
}) {
  const title = locked
    ? "This chat is already running in an isolated worktree"
    : useWorktree
      ? "This chat runs in an isolated worktree"
      : "This chat edits the selected repository directly";
  return (
    <label className={`worktreeToggle ${useWorktree ? "isOn" : ""} ${locked ? "isLocked" : ""}`} title={title}>
      <input
        type="checkbox"
        checked={useWorktree}
        disabled={disabled || locked}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      {/* The tick is drawn rather than native so it matches the pill row's
          weight; the real input stays in the DOM and keeps the semantics. */}
      <span className="worktreeToggleBox" aria-hidden="true">
        <Check size={10} strokeWidth={3.25} />
      </span>
      {/* No icon: the tick already carries the state, and a branch glyph beside
          it was a second thing to read that said nothing the word did not. */}
      <span>Worktree</span>
    </label>
  );
}

/** Formats a context window the way the menu badge shows it: "96k", "1.0M". */
export function contextBadge(contextLength: number | undefined): string | undefined {
  if (!contextLength || contextLength <= 0) return undefined;
  if (contextLength >= 1_000_000) return `${(contextLength / 1_000_000).toFixed(1)}M`;
  if (contextLength >= 1_000) return `${Math.round(contextLength / 1_000)}k`;
  return String(contextLength);
}

/**
 * Chooses whether low-risk actions run without asking. Grouped with the other
 * composer pills for the same reason as the workspace-mode picker: the row is
 * one grammar, and it stays one by living in one file.
 */
export function PermissionModePicker({
  mode,
  open,
  onToggleMenu,
  onSelect,
}: {
  mode: PermissionMode;
  open: boolean;
  onToggleMenu(): void;
  onSelect(next: PermissionMode): void;
}) {
  return (
    <div className={`permissionControl ${mode === "auto_safe" ? "isElevated" : ""}`}>
      <button
        className="permissionTrigger"
        type="button"
        onClick={onToggleMenu}
        aria-expanded={open}
        aria-haspopup="menu"
        title={mode === "auto_safe" ? "Auto-run low-risk actions" : "Ask before running actions"}
      >
        {mode === "auto_safe" ? <ShieldCheck className="elevatedPermissionsIcon" size={14} /> : <Hand size={14} />}
        <span className="permissionLabel">{mode === "auto_safe" ? "Auto-run low risk" : "Ask first"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="permissionMenu" role="menu">
          <button className={mode === "normal" ? "active" : ""} type="button" onClick={() => onSelect("normal")}>
            <Hand size={14} />
            <span>Ask first</span>
          </button>
          <button className={mode === "auto_safe" ? "active" : ""} type="button" onClick={() => onSelect("auto_safe")}>
            <ShieldCheck className="elevatedPermissionsIcon" size={14} />
            <span>Auto-run low risk</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Switches the repository's checked-out branch from the composer.
 *
 * The menu carries its own refresh and its own error line: branch listing hits
 * git, and a failure there has to be visible where the user asked, not folded
 * into the composer's general error state.
 */
export function BranchPicker({
  branch,
  branches,
  open,
  loading,
  error,
  disabled,
  checkoutPending,
  onToggleMenu,
  onRefresh,
  onSelect,
}: {
  branch: string;
  branches: string[];
  open: boolean;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  checkoutPending: boolean;
  onToggleMenu(): void;
  onRefresh(): void;
  onSelect(branch: string): void;
}) {
  return (
    <div className="branchControl">
      <button
        className="branchTrigger"
        type="button"
        onClick={onToggleMenu}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        title={`Branch: ${branch}`}
      >
        <GitBranch size={12} />
        <span>{branch}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="branchMenu" role="menu">
          <div className="branchMenuHeader">
            <span>Branches</span>
            <button className="branchRefreshButton" type="button" onClick={onRefresh} disabled={loading}>
              {loading ? <Loader2 className="spin" size={12} /> : <RefreshCw size={12} />}
            </button>
          </div>
          {error ? <div className="branchMenuError">{error}</div> : null}
          {branches.length ? (
            branches.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={candidate === branch ? "active" : ""}
                onClick={() => onSelect(candidate)}
                disabled={checkoutPending}
              >
                {candidate === branch ? <Check size={13} /> : <span className="branchSpacer" />}
                <span>{candidate}</span>
              </button>
            ))
          ) : !loading && !error ? (
            <div className="branchMenuEmpty">No branches found</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
