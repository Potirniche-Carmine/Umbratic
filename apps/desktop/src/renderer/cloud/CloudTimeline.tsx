import React, { useEffect, useRef, useState } from "react";
import type { CloudImage, CloudWorkspace } from "../../shared/cloud";
import type { ChatAttachment } from "../../shared/desktopApi";
import { cloudTurns } from "./cloudTurns";
export { cloudTurns } from "./cloudTurns";
import { WorkingBlock } from "../workingBlock";
import { MarkdownContent } from "../markdownContent";
import { ReviewFeedbackChip, ReviewFeedbackDialog } from "../review/ReviewFeedbackDialog";
import { visibleReviewPrompt, type ReviewFeedbackReference } from "../review/reviewComments";
import { UserPrompt } from "../UserPrompt";
import { CloudAttachmentPreview } from "./CloudAttachmentPreview";

export const cloudImageAttachment = (image: CloudImage): ChatAttachment => ({ path: `${image.id}${image.extension || ".png"}`, name: image.name, kind: "file", previewDataUrl: image.previewDataUrl });
export function CloudTimeline({ workspace, onLocalFile, onReviewFile }: { workspace: CloudWorkspace; onLocalFile(path: string, line?: number): void; onReviewFile(path: string): void }) {
  const [preview, setPreview] = useState<ReviewFeedbackReference[] | null>(null);
  const [imagePreview, setImagePreview] = useState<CloudImage>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tools, setTools] = useState(new Set<string>());
  const [clock, setClock] = useState(Date.now());
  const follow = useRef(new Map<string, boolean>());
  useEffect(() => { if (workspace.state === "idle") return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [workspace.state]);
  return <><div className="cloudWorkStream">{cloudTurns(workspace.entries, workspace.state !== "idle").map(turn => <React.Fragment key={turn.activity.id}>
    {turn.instruction && <UserPrompt text={visibleReviewPrompt(turn.instruction.text).text} files={(turn.instruction.images || []).map(cloudImageAttachment)}
      onOpen={file => setImagePreview(turn.instruction!.images?.find(image => cloudImageAttachment(image).path === file.path))}
      onCopy={() => void navigator.clipboard.writeText(turn.instruction!.text)}
      feedback={visibleReviewPrompt(turn.instruction.text).feedback.length > 0 && <ReviewFeedbackChip count={visibleReviewPrompt(turn.instruction.text).feedback.length} onClick={() => setPreview(visibleReviewPrompt(turn.instruction!.text).feedback)}/>}/>}
    {(turn.activity.segments.length > 0 || !turn.activity.finished) && <WorkingBlock expandWhileRunning item={turn.activity} clock={clock} expanded={expanded.has(turn.activity.id)} expandedToolIds={tools} skills={[]} followScrollRef={follow} setExpanded={setExpanded} setExpandedTools={setTools} setBodyRef={() => undefined} onPointerDown={() => undefined} onScroll={() => undefined} onTouchMove={() => undefined} onWheel={() => undefined}/>}
    {turn.answer && <article className="cloudEntry cloudEntry-answer"><MarkdownContent onLocalFileClick={onLocalFile} content={turn.answer.text} streaming={!turn.activity.finished}/></article>}
    {turn.notes.map(entry => <p key={entry.id} className={`cloudEntry cloudEntry-${entry.kind}`}>{entry.text}</p>)}
  </React.Fragment>)}</div>{imagePreview && <CloudAttachmentPreview file={imagePreview} onClose={() => setImagePreview(undefined)}/>} {preview && <ReviewFeedbackDialog comments={preview.map((comment, index) => ({ ...comment, id: String(index) }))} onClose={() => setPreview(null)} onOpenFile={onReviewFile}/>}</>;
}
