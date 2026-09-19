import React, { useEffect, useRef, useState } from "react";
import { History, Pin, X } from "lucide-react";
import type { DesktopApi, TaskCheckpointView, TaskInfo } from "../shared/desktopApi";

export function CheckpointMenu({ api, task, onRestored }: {
  api: DesktopApi;
  task: TaskInfo;
  onRestored(task: TaskInfo): void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<DesktopApi["listTaskCheckpoints"]>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<TaskCheckpointView | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelRestore = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setConfirm(null); trigger.current?.focus(); };

  useEffect(() => {
    if (confirm) cancelRestore.current?.focus();
  }, [confirm]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setData(null);
    api.listTaskCheckpoints({ taskId: task.id }).then((result) => {
      if (current) { setData(result); setError(""); }
    }).catch((cause) => { if (current) setError(String(cause)); });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setConfirm(null); }
    };
    document.addEventListener("pointerdown", outside);
    return () => { current = false; document.removeEventListener("pointerdown", outside); };
  }, [api, open, task.id, task.state]);

  async function act(action: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await action();
      setData(await api.listTaskCheckpoints({ taskId: task.id }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }

  return <div className="checkpointControl" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  }}>
    <button className="chromeButton" ref={trigger} type="button" aria-label="Checkpoints" title="Checkpoints"
      aria-expanded={open} onClick={() => { setConfirm(null); setOpen((value) => !value); }}><History size={15} /></button>
    {open ? <section className="checkpointPopover" aria-label="Checkpoints">
      <header><strong>Checkpoints</strong><button className="chromeButton" type="button" aria-label="Close checkpoints" onClick={close}><X size={14} /></button></header>
      {error ? <p role="alert">{error}</p> : null}
      {!data ? !error && <p role="status">Loading…</p> : <>
        {!data.supported ? <p>{data.reason}</p> : null}
        {confirm ? <div className="checkpointConfirm" role="group" aria-label="Confirm restore">
          <strong>Restore {confirm.label || "checkpoint"}?</strong>
          <p>This chat will continue in a new worktree. The current files and chat history are kept.</p>
          <div className="checkpointButtons"><button ref={cancelRestore} type="button" disabled={pending} onClick={() => { setConfirm(null); trigger.current?.focus(); }}>Cancel</button>
            <button type="button" disabled={pending || !data.supported} onClick={() => void act(async () => {
              const restored = await api.restoreTaskCheckpoint({ taskId: task.id, checkpointId: confirm.id, confirmed: true });
              onRestored(restored);
              setConfirm(null);
              trigger.current?.focus();
            })}>{pending ? "Restoring…" : "Restore checkpoint"}</button></div>
        </div> : <>
          <button type="button" className="checkpointSave" disabled={pending || !data.supported}
            onClick={() => void act(() => api.createTaskCheckpoint({ taskId: task.id, label: "Saved checkpoint" }))}>Save checkpoint</button>
          <div className="checkpointList">{data.checkpoints.length ? data.checkpoints.map((checkpoint) => <div className="checkpointRow" key={checkpoint.id}>
            <div><strong>{checkpoint.label || "Checkpoint"}</strong><time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></div>
            {checkpoint.pinned ? <Pin size={12} aria-label="Kept for recovery" /> : null}
            <button type="button" disabled={pending || !data.supported || checkpoint.state !== "ready"}
              onClick={() => setConfirm(checkpoint)}>{checkpoint.state === "ready" ? "Restore" : checkpoint.state === "failed" ? "Unavailable" : "Saving…"}</button>
          </div>) : <p>No checkpoints yet.</p>}</div>
        </>}
      </>}
    </section> : null}
  </div>;
}
