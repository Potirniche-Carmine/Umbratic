import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, FolderOpen, GitBranch, Hand, Loader2, Mic, RefreshCw, ShieldCheck, Square } from "lucide-react";

import type { PermissionMode, WorkspaceMode } from "../shared/desktopApi";
import type { DictationStatus } from "./dictation";

/**
 * Speaks a prompt instead of typing it.
 *
 * The live transcript is a popover above the button rather than text written
 * into the prompt: a partial is replaced whole on every update, and rewriting
 * the input under a cursor the user may have moved is how dictation eats an
 * edit someone was in the middle of. Only the final transcript is inserted.
 */
export function DictationControl({
  status,
  onToggle,
}: {
  status: DictationStatus;
  onToggle(): void;
}) {
  const recording = status.state === "recording";
  const busy = status.state === "starting" || status.state === "transcribing";
  const label = recording
    ? "Stop dictation"
    : busy
      ? status.state === "starting" ? "Starting dictation" : "Transcribing"
      : "Dictate prompt";

  return (
    <>
      {/*
        The caption is a sibling in the action rail rather than a popover above
        the button: the composer shell clips its overflow, so anything floated
        out of the rail is cut off at the shell's edge.
      */}
      {status.preview || status.error ? (
        <div className={`dictationCaption ${status.error ? "isError" : ""}`} role="status">
          {status.error ?? status.preview}
        </div>
      ) : null}
      <div className={`dictationControl ${recording ? "isRecording" : ""}`}>
      <button
        className="dictationButton"
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-label={label}
        aria-pressed={recording}
        title={label}
      >
        {busy ? (
          <Loader2 className="spin" size={16} />
        ) : recording ? (
          <Square aria-hidden="true" fill="currentColor" size={11} />
        ) : (
          <Mic aria-hidden="true" size={16} />
        )}
      </button>
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
  /** The model's context window, already formatted ("96k"). */
  contextBadge?: string;
};

/**
 * Picks which model answers the next run.
 *
 * The menu opens upward from its trigger, like every other composer menu, so
 * the control the user pressed is visibly where the menu came from.
 */
export function ComposerModelPicker({
  models,
  selectedId,
  disabled,
  disabledReason,
  onOpen,
  onSelect,
}: {
  models: ComposerModelOption[];
  selectedId: string;
  disabled: boolean;
  /** Shown as the trigger's tooltip while disabled — a control that refuses
   * silently reads as broken. */
  disabledReason?: string;
  onOpen?(): void;
  onSelect(id: string): void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = models.find((model) => model.id === selectedId);

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

  if (models.length === 0) return null;

  return (
    <div className={`modelControl ${open ? "isOpen" : ""}`} ref={rootRef}>
      <button
        className="modelTrigger"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={disabled ? disabledReason ?? "" : `Model: ${selected?.label ?? selectedId}`}
        onClick={() => {
          setOpen((current) => {
            if (!current) onOpen?.();
            return !current;
          });
        }}
      >
        <Cpu size={14} aria-hidden="true" />
        <span>{selected?.label ?? selectedId}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="modelMenu" role="menu" aria-label="Model">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={model.id === selectedId}
              className={[
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
              {model.contextBadge ? <span className="modelContextBadge">{model.contextBadge}</span> : null}
              {model.id === selectedId ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Chooses whether the next run edits the repository in place or in an isolated
 * worktree. It lives here rather than in `main.tsx` for the same reason as the
 * two controls above: the composer row is one visual grammar, and keeping its
 * markup together is what keeps it one.
 */
export function WorkspaceModePicker({
  mode,
  useWorktree,
  locked,
  disabled,
  open,
  onToggleMenu,
  onSelect,
}: {
  mode: WorkspaceMode;
  useWorktree: boolean;
  locked: boolean;
  disabled: boolean;
  open: boolean;
  onToggleMenu(): void;
  onSelect(next: WorkspaceMode): void;
}) {
  return (
    <div className={`workspaceModeControl ${useWorktree ? "isWorktree" : ""}`}>
      <button
        className="workspaceModeTrigger"
        type="button"
        onClick={onToggleMenu}
        disabled={disabled || locked}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          locked
            ? "This chat is already running in an isolated worktree"
            : useWorktree
              ? "Run this chat in an isolated worktree"
              : "Run this chat in the selected repository"
        }
      >
        {useWorktree ? <GitBranch size={14} /> : <FolderOpen size={14} />}
        <span>{useWorktree ? "Worktree" : "Local"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="workspaceModeMenu" role="menu">
          <button className={mode === "local" ? "active" : ""} type="button" onClick={() => onSelect("local")}>
            <FolderOpen size={14} />
            <span>Local</span>
          </button>
          <button className={mode === "worktree" ? "active" : ""} type="button" onClick={() => onSelect("worktree")}>
            <GitBranch size={14} />
            <span>Worktree</span>
          </button>
        </div>
      ) : null}
    </div>
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
