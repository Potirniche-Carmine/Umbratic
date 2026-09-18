import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Columns2, ExternalLink, FileText, MessageSquarePlus, PanelRight, Rows3, Undo2, WrapText } from "lucide-react";
import { isArtifactPath } from "../../shared/artifactReview";
import type { DocumentReviewSnapshot } from "../../shared/documentReview";
import type { DiffCell, DiffSide, ReviewFile, SideBySideRow } from "../../shared/reviewDiff";
import { reviewContentHash } from "../../shared/reviewDiff";
import { DocumentReviewPreview } from "./DocumentReviewPreview";
import { DiffFileView } from "./DiffFileView";
import type { ReviewLineSelection } from "./DiffRow";
import { documentReviewSelectionDetails } from "./documentReviewSelection";
import { reconcileReviewComments, type ReviewCommentDraft } from "./reviewComments";
import { setReviewLayout, setReviewWrap, useReviewLayout, useReviewWrap } from "./reviewPreferences";

/// Two 380px columns and their gutters. Below this the split layout does not
/// fit, and CSS collapsing it to one column left the rows still shaped for two:
/// an empty Before column, headers labelling columns that were not there, and
/// content running past the right edge. The layout is chosen here instead, so
/// the rows are built for the layout that is actually shown.
export const reviewSplitMinimumWidth = 760;
/// How long the "Added" confirmation stays up, fades included. Must match the
/// animation in review-diff.css: the state outliving the animation leaves an
/// invisible element in place, and the animation outliving the state cuts the
/// confirmation off mid-fade.
export const reviewFeedbackAddedDurationMs = 2400;

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

function splitReviewPath(filePath: string): { dir: string; name: string } {
  const separatorIndex = filePath.lastIndexOf("/");
  return separatorIndex < 0
    ? { dir: "", name: filePath }
    : { dir: filePath.slice(0, separatorIndex + 1), name: filePath.slice(separatorIndex + 1) };
}

const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function ReviewPanel({
  files,
  open,
  initialSelectedPath,
  taskId,
  patchHash,
  scope,
  canUseWorktreeScope,
  canOpenIde,
  canUndoFile,
  undoUnavailableReason,
  selectedIdeLabel,
  onClose,
  onUndoFile,
  onOpenFile,
  onScopeChange,
  onResizePointerDown,
  onResizeKeyDown,
  onAddFeedback,
  onLoadDocumentReview,
}: {
  files: ReviewFile[];
  /** Whether the panel is showing. A hidden panel holds no armed mode. */
  open: boolean;
  initialSelectedPath?: string;
  taskId: string;
  patchHash?: string;
  scope: "task" | "worktree";
  canUseWorktreeScope: boolean;
  canOpenIde: boolean;
  canUndoFile: boolean;
  /** Why undo is off, said in the button's tooltip instead of leaving it grey and mute. */
  undoUnavailableReason: string;
  selectedIdeLabel: string;
  onClose(): void;
  onUndoFile(path: string): void;
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
  // Read from the shared store, so a change made in General settings lands
  // here without the panel being remounted, and vice versa.
  const viewMode = useReviewLayout();
  const wrap = useReviewWrap();
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [splitFits, setSplitFits] = useState(true);
  const feedbackAddedTimerRef = useRef<number | null>(null);
  const loadDocumentReviewRef = useRef(onLoadDocumentReview);
  const actualPatchHash = patchHash || reviewContentHash(files);
  const selectedIndex = Math.max(0, files.findIndex((file) => file.path === selectedPath));
  const selectedFile = files[selectedIndex] ?? files[0];
  const selectedFileIsDocument = !!selectedFile && isArtifactPath(selectedFile.path);
  // The files arrive in the order the panel should show them: by review
  // priority when change analysis was available, by path otherwise. The panel
  // does not reorder them and does not say which one it got.
  const navigatorFiles = files;
  const navigatorTotals = useMemo(
    () => navigatorFiles.reduce(
      (total, file) => ({
        additions: total.additions + file.additions,
        deletions: total.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    ),
    [navigatorFiles],
  );

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

  // An added file has no Before column worth showing, so it renders unified —
  // as a per-file presentation, not by writing to the stored preference. The
  // previous rule set viewMode itself and never set it back, so opening one
  // new file silently turned every diff after it unified for the session.
  const effectiveViewMode: "split" | "unified" = selectedFile?.status === "added" ? "unified" : viewMode;

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
  }, [taskId, actualPatchHash, selectedFile?.path, selectedFile?.contentHash, selectedFileIsDocument]);

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

  // The width that decides the layout is the diff's own, not the panel's: the
  // file navigator takes up to 208px of the panel before the diff sees any.
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return undefined;
    const measure = () => setSplitFits(node.clientWidth >= reviewSplitMinimumWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [selectedFileIsDocument]);

  useEffect(() => {
    setSelectedScope(scope);
  }, [scope]);

  // Hiding the panel ends the feedback mode with it. Whichever way it was
  // closed, reopening on an armed "Done" with nothing selected reads as a
  // control stuck in a state the user never chose.
  useEffect(() => {
    if (open) return;
    setCommenting(false);
    setEditorOpen(false);
    setCommentBody("");
    setSelection(null);
    setDocumentSelection([]);
  }, [open]);

  const chooseViewMode = (mode: "split" | "unified") => setReviewLayout(mode);
  const toggleWrap = () => setReviewWrap(!wrap);
  const chooseScope = (nextScope: "task" | "worktree") => {
    setSelectedScope(nextScope);
    setScopeOpen(false);
    onScopeChange(nextScope);
  };
  const selectLine = useCallback((_event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell) => {
    if (!commenting || cell.line === null || !cell.hunkId) return;
    const lineNumber = cell.line;
    setSelection((current) => {
      if (current && current.hunkId === cell.hunkId && current.side === cell.side) {
        const lines = current.lines.includes(lineNumber)
          ? current.lines.filter((line) => line !== lineNumber)
          : [...current.lines, lineNumber].sort((left, right) => left - right);
        return lines.length ? { ...current, lines } : null;
      }
      return { hunkId: cell.hunkId!, side: cell.side, lines: [lineNumber] };
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
    }, reviewFeedbackAddedDurationMs);
  };
  const hasSelection = selectedFileIsDocument ? documentSelection.length > 0 : !!selection;
  // The editor opens itself the moment something is selected. It used to wait
  // behind a separate confirm button in the toolbar — an icon with a number,
  // far from the lines just clicked — and finding it was the step where
  // people got lost. Lines can still be added or removed while it is open.
  useEffect(() => {
    if (hasSelection) setEditorOpen(true);
  }, [hasSelection]);
  // Cancel and Escape are the way out of leaving feedback, not just out of one
  // comment: the mode used to stay armed with the button still reading "Done",
  // which left no visible way back and made the toolbar look stuck.
  const stopCommenting = () => {
    setCommenting(false);
    setEditorOpen(false);
    setCommentBody("");
    setSelection(null);
    setDocumentSelection([]);
  };
  const selectionCount = selectedFileIsDocument ? documentSelection.length : selection?.lines.length ?? 0;
  // Docked under the diff rather than floating over the line it belongs to.
  // The card used to open at the click point, which put it on top of the very
  // lines being commented on and moved it somewhere new on every click. One
  // fixed place at the foot of the panel is where the eye can learn to find it.
  const editor = hasSelection && editorOpen ? (
    <div className="reviewFeedbackDock">
      <div className="inlineReviewComment">
        <textarea
          ref={commentRef}
          value={commentBody}
          onChange={(event) => setCommentBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              saveComment();
            } else if (event.key === "Escape") {
              event.preventDefault();
              stopCommenting();
            }
          }}
          placeholder="Leave feedback for the next prompt…"
          aria-label="Review comment"
        />
        <div className="inlineReviewCommentActions">
          <span className="inlineReviewCommentHint" aria-hidden="true">{`${selectionCount} ${selectedFileIsDocument ? (selectionCount === 1 ? "sentence" : "sentences") : (selectionCount === 1 ? "line" : "lines")} · ${isMacPlatform ? "⌘↩ saves · esc cancels" : "Ctrl+Enter saves · Esc cancels"}`}</span>
          <button type="button" onClick={stopCommenting}>Cancel</button>
          <button className="primaryAction" type="button" onClick={saveComment} disabled={!commentBody.trim()}>Save feedback</button>
        </div>
      </div>
    </div>
  ) : null;
  const documentFeedbackEnabled = !selectedFileIsDocument || !!documentPreview;

  return (
    <section
      className="panel reviewPanel"
      aria-label={selectedFileIsDocument ? "Document review" : "Code review"}
      // Escape leaves the mode from anywhere in the panel, not only from
      // inside the comment box: with nothing selected the box is not there to
      // press it in, and that was the state with no way out.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !commenting) return;
        event.stopPropagation();
        stopCommenting();
      }}
    >
      {feedbackAdded ? <div className="reviewFeedbackAdded" role="status"><span><Check size={13} /></span><strong>Added — sends with your next message</strong></div> : null}
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
          {/* Whole diff is git's answer to "what is uncommitted", so a chat
              working outside a git folder has one scope and no choice to
              offer. A menu with a single row read as a broken picker; the
              scope is stated instead, and says why it is the only one. */}
          {canUseWorktreeScope ? (
            <div className="reviewScopePicker">
              <button type="button" className="reviewControlButton" onClick={() => setScopeOpen((open) => !open)} aria-expanded={scopeOpen}><span>{selectedScope === "worktree" ? "Whole diff" : "Turn changes"}</span><ChevronDown size={13} /></button>
              {scopeOpen ? <div className="reviewScopeMenu" role="menu"><button type="button" role="menuitemradio" aria-checked={selectedScope === "task"} className={selectedScope === "task" ? "isSelected" : ""} onClick={() => chooseScope("task")}><span><strong>Turn changes</strong><small>Changes made in this model turn</small></span>{selectedScope === "task" ? <Check size={14} /> : null}</button><button type="button" role="menuitemradio" aria-checked={selectedScope === "worktree"} className={selectedScope === "worktree" ? "isSelected" : ""} onClick={() => chooseScope("worktree")}><span><strong>Whole diff</strong><small>All uncommitted changes against HEAD</small></span>{selectedScope === "worktree" ? <Check size={14} /> : null}</button></div> : null}
            </div>
          ) : (
            <span className="reviewScopeLabel" title="Whole diff compares against HEAD, so it needs a git folder. Pick one for this chat to review uncommitted changes.">Turn changes</span>
          )}
          <button className="reviewIconButton" type="button" onClick={onClose} title="Hide review" aria-label="Hide review"><PanelRight size={16} /></button>
        </div>
      </header>
      {files.length && selectedFile ? (
        <div className={`reviewWorkspace ${navigatorFiles.length ? "" : "withoutNavigator"}`}>
          {navigatorFiles.length ? (
            <aside className="reviewFileNavigator" aria-label="Changed files">
              <div className="reviewNavigatorSummary"><span>{navigatorFiles.length} file{navigatorFiles.length === 1 ? "" : "s"}</span><span className="additions">+{navigatorTotals.additions}</span><span className="deletions">-{navigatorTotals.deletions}</span></div>
              <div className="reviewNavigatorList">{navigatorFiles.map((file) => {
                const { dir, name } = splitReviewPath(file.path);
                return (
                  <button
                    type="button"
                    className={`reviewNavigatorFile status-${file.status} ${file.path === selectedFile.path ? "isActive" : ""}`}
                    onClick={() => { setSelectedPath(file.path); setSelection(null); }}
                    title={`${file.path} · ${statusLabel(file.status)}`}
                    key={file.path}
                  >
                    <span className="reviewNavigatorRow">
                      <span className="reviewNavigatorStatusDot" aria-hidden="true" />
                      <span className="reviewNavigatorName">{name}</span>
                      <span className="reviewNavigatorCounts" aria-label={`${statusLabel(file.status)}, ${file.additions} additions, ${file.deletions} deletions`}>
                        <span className="additions">+{file.additions}</span>
                        <span className="deletions">-{file.deletions}</span>
                      </span>
                    </span>
                    {dir ? <small className="reviewNavigatorDir">{dir.replace(/\/$/, "")}</small> : null}
                  </button>
                );
              })}</div>
            </aside>
          ) : null}
          <main className="reviewFileCanvas">
            <header className="reviewFileToolbar">
              <span className="reviewSelectedFile">
                <strong title={selectedFile.path}>
                  <span className="reviewSelectedDir">{splitReviewPath(selectedFile.path).dir}</span>
                  <span className="reviewSelectedName">{splitReviewPath(selectedFile.path).name}</span>
                </strong>
                {selectedFile.oldPath ? <small>from {selectedFile.oldPath}</small> : null}
              </span>
              <div className="reviewFileActions">
                <span className="reviewFeedbackSelectionControls">
                  <button className={`reviewFeedbackModeButton ${commenting ? "isActive" : ""}`} type="button" disabled={!documentFeedbackEnabled} aria-pressed={commenting} onClick={() => { setCommenting((current) => !current); setSelection(null); setDocumentSelection([]); setEditorOpen(false); setCommentBody(""); }} title={commenting ? "Done leaving feedback" : selectedFileIsDocument && !documentFeedbackEnabled ? "A review preview is required for document feedback" : `Click ${selectedFileIsDocument ? "sentences" : "lines"} in the diff to comment on them`}><MessageSquarePlus size={14} /><span>{commenting ? "Done" : "Leave feedback"}</span></button>
                </span>
                {/* A new file has no earlier version, so there is nothing to
                    put side by side. The two buttons used to stay in the
                    toolbar `disabled`, which looked exactly like the ordinary
                    inactive state — the layout control read as broken rather
                    than as inapplicable. */}
                {!selectedFileIsDocument && splitFits && selectedFile.status !== "added" ? <span className="reviewSegmentedControl" aria-label="Diff layout"><button type="button" className={effectiveViewMode === "split" ? "isActive" : ""} onClick={() => chooseViewMode("split")} title="Side by side"><Columns2 size={14} /><span>Side by side</span></button><button type="button" className={effectiveViewMode === "unified" ? "isActive" : ""} onClick={() => chooseViewMode("unified")} title="Unified"><Rows3 size={14} /><span>Unified</span></button></span> : null}
                {!selectedFileIsDocument ? <button className={`reviewIconButton ${wrap ? "isActive" : ""}`} type="button" onClick={toggleWrap} title={wrap ? "Disable line wrapping" : "Wrap long lines"}><WrapText size={15} /></button> : null}
                <button className="reviewIconButton" type="button" onClick={() => onUndoFile(selectedFile.path)} disabled={!canUndoFile} title={canUndoFile ? `Undo changes to ${splitReviewPath(selectedFile.path).name}` : undoUnavailableReason} aria-label={`Undo changes to ${selectedFile.path}`}><Undo2 size={15} /></button>
                <button className="reviewIconButton" type="button" onClick={() => onOpenFile(selectedFile.path)} disabled={!canOpenIde || selectedFile.status === "deleted"} title={`Open in ${selectedIdeLabel}`}><ExternalLink size={15} /></button>
              </div>
            </header>
            <div className="reviewFileScroller" ref={scrollerRef}>
              {selectedFileIsDocument ? (
                documentPreviewLoading ? <div className="reviewDiffEmpty"><strong>Loading document preview…</strong></div>
                  : documentPreview ? <DocumentReviewPreview preview={documentPreview} commenting={commenting} selection={documentSelection} onSelectionChange={setDocumentSelection} />
                    : <div className="reviewDiffEmpty"><FileText size={22} /><strong>Preview unavailable</strong><span>{documentPreviewError || "Open the document externally to review it."}</span></div>
              ) : <DiffFileView file={selectedFile} viewMode={splitFits ? effectiveViewMode : "unified"} wrap={wrap} commenting={commenting} selection={selection} onSelect={selectLine} />}
            </div>
            {editor}
          </main>
        </div>
      ) : <div className="reviewEmptyState"><FileText size={24} /><strong>No changes to review</strong><span>Refresh the task after files change.</span></div>}
    </section>
  );
}
