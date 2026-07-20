import React from "react";
import { CopyPlus, GitFork, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react";

export type CheckpointItem = {
  id: string;
  source: "manual" | "pre_restore" | "pre_cleanup";
  label?: string;
  createdAt: string;
  state: "preparing" | "ready" | "failed";
  pinned: boolean;
  logicalBytes?: number;
};

function checkpointTitle(checkpoint: CheckpointItem): string {
  if (checkpoint.label) return checkpoint.label;
  if (checkpoint.source === "pre_restore") return "Recovery before restore";
  if (checkpoint.source === "pre_cleanup") return "Recovery before cleanup";
  return "Manual checkpoint";
}

function checkpointSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function CheckpointPanel({
  supported,
  reason,
  changedFileCount,
  checkpoints,
  busy,
  error,
  onCreate,
  onFork,
  onRestore,
  onPin,
  onDelete,
}: {
  supported: boolean;
  reason?: string;
  changedFileCount: number;
  checkpoints: CheckpointItem[];
  busy: boolean;
  error?: string;
  onCreate(): void;
  onFork(checkpoint: CheckpointItem): void;
  onRestore(checkpoint: CheckpointItem): void;
  onPin(checkpoint: CheckpointItem): void;
  onDelete(checkpoint: CheckpointItem): void;
}) {
  return (
    <section className="checkpointPanel" aria-label="Task checkpoints">
      <div className="checkpointHeader">
        <span><strong>Checkpoints</strong><small>{changedFileCount} current changed file{changedFileCount === 1 ? "" : "s"}</small></span>
        <button type="button" onClick={onCreate} disabled={!supported || busy} title={reason || "Preserve the current task file state"}>
          <CopyPlus size={14} /> Create
        </button>
      </div>
      {!supported && reason ? <p className="checkpointNotice">{reason}</p> : null}
      {error ? <p className="checkpointError" role="alert">{error}</p> : null}
      {checkpoints.length ? (
        <ol className="checkpointList">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id}>
              <span className="checkpointIdentity">
                <strong>{checkpointTitle(checkpoint)}</strong>
                <small>
                  {new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.state}
                  {checkpoint.logicalBytes !== undefined ? ` · ${checkpointSize(checkpoint.logicalBytes)}` : ""}
                </small>
              </span>
              <span className="checkpointActions">
                <button type="button" onClick={() => onFork(checkpoint)} disabled={busy || checkpoint.state !== "ready"} title="Fork into a new task worktree"><GitFork size={13} /><span>Fork</span></button>
                <button type="button" onClick={() => onRestore(checkpoint)} disabled={busy || checkpoint.state !== "ready"} title="Restore into a replacement worktree"><RotateCcw size={13} /><span>Restore</span></button>
                <button type="button" onClick={() => onPin(checkpoint)} disabled={busy || checkpoint.state !== "ready" || checkpoint.source !== "manual"} title={checkpoint.pinned ? "Unpin checkpoint" : "Pin checkpoint"}>{checkpoint.pinned ? <PinOff size={13} /> : <Pin size={13} />}<span>{checkpoint.pinned ? "Unpin" : "Pin"}</span></button>
                <button type="button" onClick={() => onDelete(checkpoint)} disabled={busy || checkpoint.state !== "ready" || checkpoint.pinned || checkpoint.source !== "manual"} title="Delete checkpoint"><Trash2 size={13} /><span>Delete</span></button>
              </span>
            </li>
          ))}
        </ol>
      ) : supported ? <p className="checkpointNotice">No checkpoints yet.</p> : null}
    </section>
  );
}
