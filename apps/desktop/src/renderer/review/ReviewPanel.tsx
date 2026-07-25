import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Columns2, ExternalLink, FileText, MessageSquarePlus, PanelRight, Rows3, Undo2, WrapText, X } from "lucide-react";
import {
  isDocumentReviewArtifactPath,
  type DocumentReviewSnapshot,
} from "../../shared/documentReview";
import type { DiffCell, DiffSide, ReviewFile, SideBySideRow } from "../../shared/reviewDiff";
import { reviewPatchHash } from "../../shared/reviewDiff";
import { DocumentReviewPreview } from "./DocumentReviewPreview";
import { DiffFileView } from "./DiffFileView";
import type { ReviewLineSelection } from "./DiffRow";
import { documentReviewSelectionDetails } from "./documentReviewSelection";
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
  onLoadDocumentReview,
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
  onLoadDocumentReview(documentPath: string): Promise<
    | { ok: true; preview: DocumentReviewSnapshot }
    | { ok: false; code: "not_available" | "invalid" | "unsafe" | "too_large"; message: string }
  >;
}) {
  const [selectedPath, setSelectedPath] = useState(initialSelectedPath ?? files[0]?.path ?? "");
  const [viewMode, setViewMode] = useState<"split" | "unified">(() => {
    const initialFile = files.find((file) => file.path === initialSelectedPath) ?? files[0];
    return initialFile?.status === "added" ? "unified" : initialViewMode();
  });
  // Wrapped lines are the readable default. Preserve an explicit opt-out from a
  // prior session, but do not make new reviews start with horizontal scrolling.
  const [wrap, setWrap] = useState(() => window.localStorage.getItem(wrapKey) !== "false");
  const [commenting, setCommenting] = useState(false);
  const [selection, setSelection] = useState<ReviewLineSelection | null>(null);
  const [documentSelection, setDocumentSelection] = useState<string[]>([]);
  const [documentPreview, setDocumentPreview] = useState<DocumentReviewSnapshot | null>(null);
  const [documentPreviewLoading, setDocumentPreviewLoading] = useState(false);
  const [documentPreviewError, setDocumentPreviewError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [feedbackAdded, setFeedbackAdded] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [comments, setComments] = useState<ReviewCommentDraft[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [selectedScope, setSelectedScope] = useState(scope);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackAddedTimerRef = useRef<number | null>(null);
  const loadDocumentReviewRef = useRef(onLoadDocumentReview);
  const actualPatchHash = patchHash || reviewPatchHash(files);
  const selectedIndex = Math.max(0, files.findIndex((file) => file.path === selectedPath));
  const selectedFile = files[selectedIndex] ?? files[0];
  const selectedFileIsDocument = !!selectedFile && isDocumentReviewArtifactPath(selectedFile.path);
  const totals = useMemo(() => files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 }), [files]);

  useEffect(() => {
    loadDocumentReviewRef.current = onLoadDocumentReview;
  }, [onLoadDocumentReview]);

  useEffect(() => {
    if (!files.some((file) => file.path === selectedPath)) setSelectedPath(files[Math.min(selectedIndex, files.length - 1)]?.path ?? "");
    setComments((current) => reconcileReviewComments(current, files, actualPatchHash));
  }, [actualPatchHash, files, selectedPath, selectedIndex]);

  useEffect(() => {
    if (initialSelectedPath && files.some((file) => file.path === initialSelectedPath)) setSelectedPath(initialSelectedPath);
  }, [files, initialSelectedPath]);

  useEffect(() => {
    if (selectedFile?.status === "added") setViewMode("unified");
  }, [selectedFile?.path, selectedFile?.status]);

  useEffect(() => {
    let active = true;
    setDocumentSelection([]);
    setDocumentPreview(null);
    setDocumentPreviewError("");
    setDocumentPreviewLoading(selectedFileIsDocument);
    setEditorOpen(false);
    setCommentBody("");
    if (!selectedFileIsDocument || !selectedFile) {
      setDocumentPreviewLoading(false);
      return () => {
        active = false;
      };
    }
    void loadDocumentReviewRef.current(selectedFile.path).then((result) => {
      if (!active) return;
      setDocumentPreviewLoading(false);
      if (result.ok) setDocumentPreview(result.preview);
      else setDocumentPreviewError(result.message);
    }).catch(() => {
      if (!active) return;
      setDocumentPreviewLoading(false);
      setDocumentPreviewError("The document preview could not be loaded.");
    });
    return () => {
      active = false;
    };
  }, [selectedFile?.path, selectedFileIsDocument]);

  useEffect(() => {
    setComments([]);
    setSelection(null);
    setDocumentSelection([]);
    setCommentBody("");
    setFeedbackAdded(false);
  }, [taskId]);

  useEffect(() => () => {
    if (feedbackAddedTimerRef.current !== null) window.clearTimeout(feedbackAddedTimerRef.current);
  }, []);

  useEffect(() => {
    if (editorOpen) commentRef.current?.focus();
  }, [editorOpen]);

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
  const selectLine = useCallback((event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell, row: SideBySideRow) => {
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
  }, [commenting]);
  const saveComment = () => {
    if (!selectedFile || !commentBody.trim()) return;
    const documentDetails = selectedFileIsDocument && documentPreview
      ? documentReviewSelectionDetails(documentPreview, documentSelection)
      : null;
    if (selectedFileIsDocument && !documentDetails) return;
    if (!selectedFileIsDocument && !selection) return;
    const selectedLines = documentDetails
      ? documentDetails.blockIds
        .map((id) => documentPreview!.blocks.findIndex((block) => block.id === id) + 1)
        .filter((line) => line > 0)
      : [...selection!.lines].sort((left, right) => left - right);
    const comment: ReviewCommentDraft = {
      id: `review-${Date.now().toString(36)}-${comments.length}`,
      taskId,
      patchHash: actualPatchHash,
      filePath: selectedFile.path,
      hunkId: documentDetails ? `document:${documentPreview!.documentPath}` : selection!.hunkId,
      side: documentDetails ? "new" : selection!.side,
      startLine: selectedLines[0],
      endLine: selectedLines[selectedLines.length - 1],
      lineNumbers: selectedLines,
      body: commentBody.trim(),
      excerpt: documentDetails ? documentDetails.excerpt : selectedExcerpt(selectedFile, selection!),
      ...(documentDetails ? {
        documentSelection: {
          blockIds: documentDetails.blockIds,
          sentenceIds: documentDetails.sentenceIds,
          label: documentDetails.label,
        },
      } : {}),
    };
    setComments((current) => [...current, comment]);
    onAddFeedback([comment]);
    setSelection(null);
    setDocumentSelection([]);
    setEditorOpen(false);
    setCommentBody("");
    setFeedbackAdded(true);
    if (feedbackAddedTimerRef.current !== null) window.clearTimeout(feedbackAddedTimerRef.current);
    feedbackAddedTimerRef.current = window.setTimeout(() => {
      setFeedbackAdded(false);
      feedbackAddedTimerRef.current = null;
    }, 1800);
  };
  const hasSelection = selectedFileIsDocument ? documentSelection.length > 0 : !!selection;
  const editor = hasSelection && editorOpen ? (
    <div className="inlineReviewComment">
      <textarea ref={commentRef} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Leave feedback for the next prompt…" aria-label="Review comment" />
      <div className="inlineReviewCommentActions"><button type="button" onClick={() => { setEditorOpen(false); setCommentBody(""); }}>Cancel</button><button className="primaryAction" type="button" onClick={saveComment} disabled={!commentBody.trim()}>Save feedback</button></div>
    </div>
  ) : null;
  const selectionCount = selectedFileIsDocument ? documentSelection.length : selection?.lines.length ?? 0;
  const documentFeedbackEnabled = !selectedFileIsDocument || !!documentPreview;

  return (
    <section className="panel reviewPanel" aria-label={selectedFileIsDocument ? "Document review" : "Code review"}>
      {feedbackAdded ? <div className="reviewFeedbackAdded" role="status"><span><Check size={13} /></span><strong>Added</strong></div> : null}
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
            <button type="button" className="reviewControlButton" onClick={() => setScopeOpen((open) => !open)} aria-expanded={scopeOpen}><span>{selectedScope === "worktree" ? "Whole diff" : "Turn changes"}</span><ChevronDown size={13} /></button>
            {scopeOpen ? <div className="reviewScopeMenu" role="menu"><button type="button" role="menuitemradio" aria-checked={selectedScope === "task"} className={selectedScope === "task" ? "isSelected" : ""} onClick={() => chooseScope("task")}><span><strong>Turn changes</strong><small>Changes made in this model turn</small></span>{selectedScope === "task" ? <Check size={14} /> : null}</button>{canUseWorktreeScope ? <button type="button" role="menuitemradio" aria-checked={selectedScope === "worktree"} className={selectedScope === "worktree" ? "isSelected" : ""} onClick={() => chooseScope("worktree")}><span><strong>Whole diff</strong><small>All uncommitted changes against HEAD</small></span>{selectedScope === "worktree" ? <Check size={14} /> : null}</button> : null}</div> : null}
          </div>
          <button className="reviewIconButton" type="button" onClick={onUndo} disabled={!canUndo} title="Undo this turn's changes"><Undo2 size={15} /></button>
          <button className="reviewIconButton" type="button" onClick={onClose} title="Hide review" aria-label="Hide review"><PanelRight size={16} /></button>
        </div>
      </header>
      {files.length && selectedFile ? (
        <div className="reviewWorkspace">
          <aside className="reviewFileNavigator" aria-label="Changed files">
            <div className="reviewNavigatorSummary"><span>{files.length} file{files.length === 1 ? "" : "s"}</span><span className="additions">+{totals.additions}</span><span className="deletions">-{totals.deletions}</span></div>
            <div className="reviewNavigatorList">{files.map((file) => <button type="button" className={`reviewNavigatorFile status-${file.status} ${file.path === selectedFile.path ? "isActive" : ""}`} onClick={() => { setSelectedPath(file.path); setSelection(null); }} key={file.path}><span>{file.path}</span><small><span>{statusLabel(file.status)}</span><span className="additions">+{file.additions}</span><span className="deletions">-{file.deletions}</span></small></button>)}</div>
          </aside>
          <main className="reviewFileCanvas">
            <header className="reviewFileToolbar">
              <span className="reviewSelectedFile"><strong title={selectedFile.path}>{selectedFile.path}</strong>{selectedFile.oldPath ? <small>from {selectedFile.oldPath}</small> : null}</span>
              <div className="reviewFileActions">
                <span className="reviewFeedbackSelectionControls">
                  <span className="reviewSelectionConfirmSlot">{selectionCount && !editorOpen ? <button className="reviewSelectionConfirm" type="button" onClick={() => setEditorOpen(true)} aria-label={`Write feedback for ${selectionCount} selected ${selectedFileIsDocument ? (selectionCount === 1 ? "sentence" : "sentences") : (selectionCount === 1 ? "line" : "lines")}`} title="Continue with selection"><Check size={14} /><span>{selectionCount}</span></button> : null}</span>
                  <button className={`reviewFeedbackModeButton ${commenting ? "isActive" : ""}`} type="button" disabled={!documentFeedbackEnabled} aria-pressed={commenting} onClick={() => { setCommenting((current) => !current); setSelection(null); setDocumentSelection([]); setEditorOpen(false); setCommentBody(""); }} title={commenting ? `Click ${selectedFileIsDocument ? "sentences or paragraph numbers" : "lines"} to add or remove them from this comment` : selectedFileIsDocument && !documentFeedbackEnabled ? "A review preview is required for document feedback" : `Select ${selectedFileIsDocument ? "sentences or paragraphs" : "lines"} to leave feedback`}><MessageSquarePlus size={14} /><span>{commenting ? (selectedFileIsDocument ? "Select text" : "Select lines") : "Leave feedback"}</span></button>
                </span>
                {!selectedFileIsDocument ? <span className="reviewSegmentedControl" aria-label="Diff layout"><button type="button" className={viewMode === "split" ? "isActive" : ""} onClick={() => chooseViewMode("split")} title="Side by side"><Columns2 size={14} /><span>Side by side</span></button><button type="button" className={viewMode === "unified" ? "isActive" : ""} onClick={() => chooseViewMode("unified")} title="Unified"><Rows3 size={14} /><span>Unified</span></button></span> : null}
                {!selectedFileIsDocument ? <button className={`reviewIconButton ${wrap ? "isActive" : ""}`} type="button" onClick={toggleWrap} title={wrap ? "Disable line wrapping" : "Wrap long lines"}><WrapText size={15} /></button> : null}
                <button className="reviewIconButton" type="button" onClick={() => onOpenFile(selectedFile.path)} disabled={!canOpenIde || selectedFile.status === "deleted"} title={`Open in ${selectedIdeLabel}`}><ExternalLink size={15} /></button>
              </div>
            </header>
            <div className="reviewFileScroller">
              {selectedFileIsDocument ? (
                documentPreviewLoading ? <div className="reviewDiffEmpty"><strong>Loading document preview…</strong></div>
                  : documentPreview ? <DocumentReviewPreview preview={documentPreview} commenting={commenting} selection={documentSelection} editor={editor} onSelectionChange={setDocumentSelection} />
                    : <div className="reviewDiffEmpty"><FileText size={22} /><strong>Preview unavailable</strong><span>{documentPreviewError || "Open the document externally to review it."}</span></div>
              ) : <DiffFileView file={selectedFile} viewMode={viewMode} wrap={wrap} commenting={commenting} selection={selection} onSelect={selectLine} editor={editor} />}
            </div>
          </main>
        </div>
      ) : <div className="reviewEmptyState"><FileText size={24} /><strong>No changes to review</strong><span>Refresh the task after files change.</span></div>}
      {approvalVisible ? <footer className="reviewFooter"><span className="reviewEndLabel">End of changes</span><button className="rejectAction" type="button" disabled={!canUndo} onClick={onUndo}><X size={15} />Reject changes</button><button className="primaryAction" type="button" disabled={!canApprove} onClick={onApprove}><Check size={15} />Accept</button></footer> : null}
    </section>
  );
}
