import React, { useEffect, useRef } from "react";
import { ChevronRight, MessageSquareText, X } from "lucide-react";

export function ReviewFeedbackChip({ count, onClick }: { count: number; onClick(): void }) {
  return <button className="composerReviewFeedback" type="button" onClick={onClick} aria-haspopup="dialog"><span className="composerReviewFeedbackIcon"><MessageSquareText size={12}/></span><span>Review feedback{count > 1 ? ` · ${count}` : ""}</span><ChevronRight className="composerReviewFeedbackChevron" size={12} aria-hidden="true"/></button>;
}
export function ReviewFeedbackDialog({ comments, onClose, onRemove, onRemoveAll, onOpenFile }: {
  comments: { id: string; filePath: string; lineLabel: string; body: string }[];
  onClose(): void; onRemove?(id: string): void; onRemoveAll?(): void; onOpenFile(path: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={ref} className="reviewFeedbackDialog sharedReviewFeedback" aria-labelledby="review-feedback-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><span><MessageSquareText size={16}/><strong id="review-feedback-title">Review feedback</strong><small>{comments.length}</small></span><button type="button" onClick={onClose} aria-label="Close review feedback"><X size={16}/></button></header>
    <div>{comments.map(comment => <article key={comment.id}><div><button className="reviewFeedbackFileLink" type="button" onClick={() => { onClose(); onOpenFile(comment.filePath); }}><strong>{comment.filePath}</strong></button><small>{comment.lineLabel}</small></div><p>{comment.body}</p>{onRemove && <button type="button" onClick={() => onRemove(comment.id)} aria-label={`Remove feedback for ${comment.filePath}`}><X size={13}/></button>}</article>)}</div>
    <footer>{onRemoveAll && <button type="button" onClick={() => { onRemoveAll(); onClose(); }}>Remove all</button>}<button className="primaryAction" type="button" onClick={onClose}>Done</button></footer>
  </dialog>;
}
