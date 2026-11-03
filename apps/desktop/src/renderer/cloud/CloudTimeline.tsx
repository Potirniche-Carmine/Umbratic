import React, { useEffect, useRef, useState } from "react";
import type { CloudEntry, CloudImage, CloudWorkspace } from "../../shared/cloud";
import type { ChatAttachment } from "../../shared/desktopApi";
import type { ComposerTimelineItem, ComposerActivitySegment } from "../rendererTypes";
import { WorkingBlock } from "../workingBlock";
import { MarkdownContent } from "../markdownContent";
import { AttachmentPreviewList } from "../attachmentPreview";
import { ReviewFeedbackChip, ReviewFeedbackDialog } from "../review/ReviewFeedbackDialog";
import { visibleReviewPrompt, type ReviewFeedbackReference } from "../review/reviewComments";

export const cloudImageAttachment = (image: CloudImage): ChatAttachment => ({ path: `${image.id}.png`, name: image.name, kind: "file", previewDataUrl: image.previewDataUrl });
type Activity = Extract<ComposerTimelineItem, { type: "activity" }>;
export function cloudTurns(entries: CloudEntry[], running: boolean): { instruction?: CloudEntry; activity: Activity; answer?: CloudEntry; notes: CloudEntry[] }[] {
  const groups: CloudEntry[][] = [];
  for (const entry of entries) {
    if (entry.kind === "instruction" || !groups.length) groups.push([]);
    groups.at(-1)!.push(entry);
  }
  return groups.map((group, index) => {
    const last = [...group].reverse().find(entry => entry.kind === "answer");
    const afterLast = last ? group.slice(group.indexOf(last) + 1).some(entry => entry.kind === "activity" && entry.tool?.status === "running") : false;
    const answer = afterLast ? undefined : last;
    const finished = !running || index !== groups.length - 1;
    const segments: ComposerActivitySegment[] = group.flatMap(entry => {
      if (entry.kind === "answer" && entry !== answer) return [{ type: "reasoning", id: entry.id, text: entry.text, durationMs: null, finished: true } as ComposerActivitySegment];
      if (entry.kind !== "activity") return [];
      const tool = entry.tool;
      return [{ type: "command", id: entry.id, run: { id: entry.id, command: tool?.label || entry.text, cwd: "", stdout: tool?.detail || "", stderr: "", exitCode: null,
        status: tool?.status === "running" ? "running" : tool?.status === "failed" ? "failed" : "passed", resultStatus: tool?.status, startedAt: entry.at } } as ComposerActivitySegment];
    });
    return { instruction: group.find(entry => entry.kind === "instruction"), answer,
      activity: { type: "activity", id: `work-${group[0].id}`, segments, startedAt: group[0].at, endedAt: finished ? group.at(-1)!.at : undefined, finished },
      notes: group.filter(entry => entry.kind === "error" || entry.kind === "context") };
  });
}
export function CloudTimeline({ workspace, showActivity, onReviewFile }: { workspace: CloudWorkspace; showActivity: boolean; onReviewFile(path: string): void }) {
  const [preview, setPreview] = useState<ReviewFeedbackReference[] | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tools, setTools] = useState(new Set<string>());
  const [clock, setClock] = useState(Date.now());
  const follow = useRef(new Map<string, boolean>());
  useEffect(() => { if (workspace.state === "idle") return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [workspace.state]);
  return <><div className="cloudWorkStream">{cloudTurns(workspace.entries, workspace.state !== "idle").map(turn => <React.Fragment key={turn.activity.id}>
    {turn.instruction && <article className="cloudEntry cloudEntry-instruction"><p>{visibleReviewPrompt(turn.instruction.text).text}</p>{visibleReviewPrompt(turn.instruction.text).feedback.length > 0 && <ReviewFeedbackChip count={visibleReviewPrompt(turn.instruction.text).feedback.length} onClick={() => setPreview(visibleReviewPrompt(turn.instruction!.text).feedback)}/>}<AttachmentPreviewList mode="message" files={(turn.instruction.images || []).map(cloudImageAttachment)}/></article>}
    {showActivity && (turn.activity.segments.length > 0 || !turn.activity.finished) && <WorkingBlock item={turn.activity} clock={clock} expanded={expanded.has(turn.activity.id)} expandedToolIds={tools} skills={[]} followScrollRef={follow} setExpanded={setExpanded} setExpandedTools={setTools} setBodyRef={() => undefined} onPointerDown={() => undefined} onScroll={() => undefined} onTouchMove={() => undefined} onWheel={() => undefined}/>}
    {!showActivity && turn.activity.segments.filter(segment => segment.type === "reasoning").map(segment => segment.type === "reasoning" && <article key={segment.id} className="cloudEntry cloudEntry-answer"><MarkdownContent content={segment.text} streaming={false}/></article>)}
    {turn.answer && <article className="cloudEntry cloudEntry-answer"><MarkdownContent content={turn.answer.text} streaming={!turn.activity.finished}/></article>}
    {turn.notes.map(entry => <p key={entry.id} className={`cloudEntry cloudEntry-${entry.kind}`}>{entry.text}</p>)}
  </React.Fragment>)}</div>{preview && <ReviewFeedbackDialog comments={preview.map((comment, index) => ({ ...comment, id: String(index) }))} onClose={() => setPreview(null)} onOpenFile={onReviewFile}/>}</>;
}
