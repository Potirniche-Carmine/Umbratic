import React, { useEffect, useRef } from "react";
import { ChevronRight, MessageSquareText, Trash2, X } from "lucide-react";
import { compactPath } from "../compactPath";
import { ShortcutTooltip, Tooltip } from "../Tooltip";

export function ReviewFeedbackChip({ count, onClick }: { count: number; onClick(): void }) {
  return <button className="composerReviewFeedback" type="button" onClick={onClick} aria-haspopup="dialog"><span className="composerReviewFeedbackIcon"><MessageSquareText size={12}/></span><span>Review feedback{count > 1 ? ` · ${count}` : ""}</span><ChevronRight className="composerReviewFeedbackChevron" size={12} aria-hidden="true"/></button>;
}
export function ReviewFeedbackDialog({ comments, onClose, onRemove, onRemoveAll, onOpenFile }: {
  comments: { id: string; filePath: string; lineLabel: string; body: string }[];
  onClose(): void; onRemove?(id: string): void; onRemoveAll?(): void; onOpenFile(path: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={ref} className="reviewFeedbackDialog sharedReviewFeedback" aria-labelledby="review-feedback-title" onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><strong id="review-feedback-title">Feedback</strong><div className="reviewFeedbackActions">
      {onRemoveAll && comments.length > 1 && <Tooltip content="Remove all feedback"><button type="button" onClick={() => { onRemoveAll(); onClose(); }} aria-label="Remove all feedback"><Trash2 size={15}/></button></Tooltip>}
      <ShortcutTooltip id="dialog.dismiss" label="Close feedback"><button type="button" onClick={onClose} aria-label="Close review feedback"><X size={17}/></button></ShortcutTooltip>
    </div></header>
    <div className="reviewFeedbackComments">{comments.map(comment => {
      const label = compactPath(comment.filePath, comments.map(item => item.filePath));
      return <article key={comment.id}><div><button className="reviewFeedbackFileLink" type="button" title={comment.filePath} onClick={() => { onClose(); onOpenFile(comment.filePath); }}><strong>{label}</strong></button><small>{comment.lineLabel.replace(/^Lines? /, "L")}</small></div><p>{comment.body}</p>
        {onRemove && <Tooltip content="Remove feedback"><button className="reviewFeedbackRemove" type="button" onClick={() => { onRemove(comment.id); if (comments.length === 1) onClose(); }} aria-label={`Remove feedback for ${label}`}><X size={14}/></button></Tooltip>}</article>;
    })}</div>
  </dialog>;
}
