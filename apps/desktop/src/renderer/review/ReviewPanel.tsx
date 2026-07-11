import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Columns2, ExternalLink, FileText, MessageSquarePlus, PanelRight, Rows3, Undo2, WrapText, X } from "lucide-react";
import type { DiffCell, DiffSide, ReviewFile, SideBySideRow } from "../../shared/reviewDiff";
import { reviewPatchHash } from "../../shared/reviewDiff";
import { DiffFileView } from "./DiffFileView";
import type { ReviewLineSelection } from "./DiffRow";
import { reconcileReviewComments, type ReviewCommentDraft } from "./reviewComments";

const viewModeKey = "umbratic-review-view-mode";
const wrapKey = "umbratic-review-wrap";

function initialViewMode(): "split" | "unified" {
  return window.localStorage.getItem(viewModeKey) === "unified" ? "unified" : "split";
}

function selectedExcerpt(file: ReviewFile, selection: ReviewLineSelection): string {
  const hunk = file.hunks.find((candidate) => candidate.id === selection.hunkId);
  return (hunk?.lines ?? [])
    .filter((line) => {
      const number = selection.side === "old" ? line.oldLine : line.newLine;
      return number !== null && selection.lines.includes(number);
    })
    .map((line) => line.content)
    .join("\n")
    .slice(0, 240);
}

function statusLabel(status: ReviewFile["status"]): string {
  return status === "binary" ? "Binary" : `${status[0].toUpperCase()}${status.slice(1)}`;
}

export function ReviewPanel({
  files,
  initialSelectedPath,
  taskId,
  patchHash,
  scope,
  canUseWorktreeScope,
  canOpenIde,
  canUndo,
  canApprove,
  selectedIdeLabel,
  approvalVisible,
  onClose,
  onUndo,
  onApprove,
  onOpenFile,
  onScopeChange,
  onResizePointerDown,
  onResizeKeyDown,
  onAddFeedback,
}: {
  files: ReviewFile[];
  initialSelectedPath?: string;
  taskId: string;
  patchHash?: string;
  scope: "task" | "worktree";
  canUseWorktreeScope: boolean;
  canOpenIde: boolean;
  canUndo: boolean;
  canApprove: boolean;
  selectedIdeLabel: string;
  approvalVisible: boolean;
  onClose(): void;
  onUndo(): void;
  onApprove(): void;
  onOpenFile(path: string): void;
  onScopeChange(scope: "task" | "worktree"): void;
  onResizePointerDown(event: React.PointerEvent<HTMLDivElement>): void;
  onResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  onAddFeedback(comments: ReviewCommentDraft[]): void;
}) {
  const [selectedPath, setSelectedPath] = useState(initialSelectedPath ?? files[0]?.path ?? "");
  const [viewMode, setViewMode] = useState<"split" | "unified">(initialViewMode);
  // Wrapped lines are the readable default. Preserve an explicit opt-out from a
  // prior session, but do not make new reviews start with horizontal scrolling.
  const [wrap, setWrap] = useState(() => window.localStorage.getItem(wrapKey) !== "false");
  const [commenting, setCommenting] = useState(false);
  const [selection, setSelection] = useState<ReviewLineSelection | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [comments, setComments] = useState<ReviewCommentDraft[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [selectedScope, setSelectedScope] = useState(scope);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const actualPatchHash = patchHash || reviewPatchHash(files);
  const selectedIndex = Math.max(0, files.findIndex((file) => file.path === selectedPath));
  const selectedFile = files[selectedIndex] ?? files[0];
  const totals = useMemo(() => files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 }), [files]);

  useEffect(() => {
    if (!files.some((file) => file.path === selectedPath)) setSelectedPath(files[Math.min(selectedIndex, files.length - 1)]?.path ?? "");
    setComments((current) => reconcileReviewComments(current, files, actualPatchHash));
  }, [actualPatchHash, files, selectedPath, selectedIndex]);

  useEffect(() => {
    if (initialSelectedPath && files.some((file) => file.path === initialSelectedPath)) setSelectedPath(initialSelectedPath);
  }, [files, initialSelectedPath]);

  useEffect(() => {
    setComments([]);
    setSelection(null);
    setCommentBody("");
  }, [taskId]);

  useEffect(() => {
    if (selection) commentRef.current?.focus();
  }, [selection]);

  useEffect(() => {
    setSelectedScope(scope);
  }, [scope]);

  const chooseViewMode = (mode: "split" | "unified") => {
    setViewMode(mode);
    window.localStorage.setItem(viewModeKey, mode);
  };
  const toggleWrap = () => {
    setWrap((current) => {
      window.localStorage.setItem(wrapKey, String(!current));
      return !current;
    });
  };
  const chooseScope = (nextScope: "task" | "worktree") => {
    setSelectedScope(nextScope);
    setScopeOpen(false);
    onScopeChange(nextScope);
  };
  const selectLine = (event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell, row: SideBySideRow) => {
    if (!commenting || cell.line === null || !cell.hunkId) return;
    const lineNumber = cell.line;
    setSelection((current) => {
      if (current && current.hunkId === cell.hunkId && current.side === cell.side) {
        const lines = current.lines.includes(lineNumber)
          ? current.lines.filter((line) => line !== lineNumber)
          : [...current.lines, lineNumber].sort((left, right) => left - right);
        return lines.length ? { ...current, lines, rowId: row.id } : null;
      }
      return { hunkId: cell.hunkId!, side: cell.side, lines: [lineNumber], rowId: row.id };
    });
  };
  const saveComment = () => {
    if (!selection || !selectedFile || !commentBody.trim()) return;
    const selectedLines = [...selection.lines].sort((left, right) => left - right);
    setComments((current) => [...current, {
      id: `review-${Date.now().toString(36)}-${current.length}`,
      taskId,
      patchHash: actualPatchHash,
      filePath: selectedFile.path,
      hunkId: selection.hunkId,
      side: selection.side,
      startLine: selectedLines[0],
      endLine: selectedLines[selectedLines.length - 1],
      lineNumbers: selectedLines,
      body: commentBody.trim(),
      excerpt: selectedExcerpt(selectedFile, selection),
    }]);
    setSelection(null);
    setCommentBody("");
  };
  const editor = selection ? (
    <div className="inlineReviewComment">
      <textarea ref={commentRef} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Leave feedback for the next prompt…" aria-label="Review comment" />
      <div><button type="button" onClick={() => { setSelection(null); setCommentBody(""); }}>Cancel</button><button className="primaryAction" type="button" onClick={saveComment} disabled={!commentBody.trim()}>Save feedback</button></div>
    </div>
  ) : null;

  return (
    <section className="panel reviewPanel" aria-label="Code review">
      <div
        className="reviewResizeHandle"
        role="separator"
        aria-label="Resize review panel"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
      />
      <header className="reviewTopbar">
        <strong className="reviewChangeSummary">Review</strong>
        <div className="reviewTopActions">
          <div className="reviewScopePicker">
            <button type="button" className="reviewControlButton" onClick={() => setScopeOpen((open) => !open)} aria-expanded={scopeOpen}><span>{selectedScope === "worktree" ? "Whole diff" : "Chat changes"}</span><ChevronDown size={13} /></button>
            {scopeOpen ? <div className="reviewScopeMenu" role="menu"><button type="button" role="menuitemradio" aria-checked={selectedScope === "task"} className={selectedScope === "task" ? "isSelected" : ""} onClick={() => chooseScope("task")}><span><strong>Chat changes</strong><small>Changes made in this chat</small></span>{selectedScope === "task" ? <Check size={14} /> : null}</button>{canUseWorktreeScope ? <button type="button" role="menuitemradio" aria-checked={selectedScope === "worktree"} className={selectedScope === "worktree" ? "isSelected" : ""} onClick={() => chooseScope("worktree")}><span><strong>Whole diff</strong><small>All uncommitted changes against HEAD</small></span>{selectedScope === "worktree" ? <Check size={14} /> : null}</button> : null}</div> : null}
          </div>
          <button className="reviewIconButton" type="button" onClick={onUndo} disabled={!canUndo} title="Undo this chat's changes"><Undo2 size={15} /></button>
          <button className="reviewIconButton" type="button" onClick={onClose} title="Hide review" aria-label="Hide review"><PanelRight size={16} /></button>
        </div>
      </header>
      {files.length && selectedFile ? (
        <div className="reviewWorkspace">
          <aside className="reviewFileNavigator" aria-label="Changed files">
            <div className="reviewNavigatorSummary"><span>{files.length} file{files.length === 1 ? "" : "s"}</span><span className="additions">+{totals.additions}</span><span className="deletions">-{totals.deletions}</span></div>
            <div className="reviewNavigatorList">{files.map((file) => <button type="button" className={`reviewNavigatorFile status-${file.status} ${file.path === selectedFile.path ? "isActive" : ""}`} onClick={() => { setSelectedPath(file.path); setSelection(null); }} key={file.path}><span>{file.path}</span><small><span>{statusLabel(file.status)}</span><span className="additions">+{file.additions}</span><span className="deletions">-{file.deletions}</span>{comments.some((comment) => comment.filePath === file.path) ? <span>{comments.filter((comment) => comment.filePath === file.path).length} note</span> : null}</small></button>)}</div>
          </aside>
          <main className="reviewFileCanvas">
            <header className="reviewFileToolbar">
              <span className="reviewSelectedFile"><strong title={selectedFile.path}>{selectedFile.path}</strong>{selectedFile.oldPath ? <small>from {selectedFile.oldPath}</small> : null}</span>
              <div className="reviewFileActions">
                <button className={`reviewFeedbackModeButton ${commenting ? "isActive" : ""}`} type="button" aria-pressed={commenting} onClick={() => { setCommenting((current) => !current); setSelection(null); setCommentBody(""); }} title={commenting ? "Click lines to add or remove them from this comment" : "Select lines to leave feedback"}><MessageSquarePlus size={14} /><span>{commenting ? "Select lines" : "Leave feedback"}</span></button>
                <span className="reviewSegmentedControl" aria-label="Diff layout"><button type="button" className={viewMode === "split" ? "isActive" : ""} onClick={() => chooseViewMode("split")} title="Side by side"><Columns2 size={14} /><span>Side by side</span></button><button type="button" className={viewMode === "unified" ? "isActive" : ""} onClick={() => chooseViewMode("unified")} title="Unified"><Rows3 size={14} /><span>Unified</span></button></span>
                <button className={`reviewIconButton ${wrap ? "isActive" : ""}`} type="button" onClick={toggleWrap} title={wrap ? "Disable line wrapping" : "Wrap long lines"}><WrapText size={15} /></button>
                <button className="reviewIconButton" type="button" onClick={() => onOpenFile(selectedFile.path)} disabled={!canOpenIde || selectedFile.status === "deleted"} title={`Open in ${selectedIdeLabel}`}><ExternalLink size={15} /></button>
              </div>
            </header>
            <div className="reviewFileScroller"><DiffFileView file={selectedFile} viewMode={viewMode} wrap={wrap} commenting={commenting} selection={selection} onSelect={selectLine} editor={editor} /></div>
          </main>
        </div>
      ) : <div className="reviewEmptyState"><FileText size={24} /><strong>No changes to review</strong><span>Refresh the task after files change.</span></div>}
      {comments.length ? <section className="reviewFeedbackTray" aria-label="Pending review feedback"><div className="reviewFeedbackItems">{comments.map((comment) => <article className={comment.stale ? "isStale" : ""} key={comment.id}><span><strong title={comment.filePath}>{comment.filePath}</strong><code title={comment.excerpt}>{comment.excerpt || "Blank line"}</code><p title={comment.body}>{comment.body}</p></span><button type="button" onClick={() => setComments((current) => current.filter((candidate) => candidate.id !== comment.id))} aria-label="Remove feedback"><X size={12} /></button></article>)}</div><button className="primaryAction" type="button" disabled={!comments.some((comment) => !comment.stale)} onClick={() => onAddFeedback(comments)}>Add feedback</button></section> : null}
      {approvalVisible ? <footer className="reviewFooter"><span className="reviewEndLabel">End of changes</span><button className="rejectAction" type="button" disabled={!canUndo} onClick={onUndo}><X size={15} />Reject changes</button><button className="primaryAction" type="button" disabled={!canApprove} onClick={onApprove}><Check size={15} />Accept</button></footer> : null}
    </section>
  );
}
