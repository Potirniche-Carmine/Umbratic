import type { DiffSide, ReviewFile } from "../../shared/reviewDiff";

export type ReviewCommentDraft = {
  id: string;
  taskId: string;
  patchHash: string;
  filePath: string;
  hunkId: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  lineNumbers?: number[];
  body: string;
  excerpt: string;
  stale?: boolean;
};

export function reconcileReviewComments(comments: ReviewCommentDraft[], files: ReviewFile[], patchHash: string): ReviewCommentDraft[] {
  return comments.map((comment) => {
    const file = files.find((candidate) => candidate.path === comment.filePath);
    const hunk = file?.hunks.find((candidate) => candidate.id === comment.hunkId);
    const lineNumbers = hunk?.lines
      .map((line) => (comment.side === "old" ? line.oldLine : line.newLine))
      .filter((line): line is number => line !== null) ?? [];
    const selectedLines = reviewCommentLines(comment);
    const resolves = !!hunk && selectedLines.every((line) => lineNumbers.includes(line));
    return { ...comment, patchHash: resolves ? patchHash : comment.patchHash, stale: !resolves };
  });
}

export function reviewCommentLines(comment: ReviewCommentDraft): number[] {
  const legacyRange = Array.from(
    { length: Math.max(1, comment.endLine - comment.startLine + 1) },
    (_, index) => comment.startLine + index,
  );
  return [...new Set(comment.lineNumbers?.length ? comment.lineNumbers : legacyRange)]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function reviewCommentLineLabel(comment: ReviewCommentDraft): string {
  const lines = reviewCommentLines(comment);
  const groups: string[] = [];
  let start = lines[0];
  let end = lines[0];
  for (const line of lines.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    groups.push(start === end ? String(start) : `${start}-${end}`);
    start = line;
    end = line;
  }
  if (start !== undefined) groups.push(start === end ? String(start) : `${start}-${end}`);
  return `Lines ${groups.join(", ")}`;
}

export function serializeReviewComments(comments: ReviewCommentDraft[]): string {
  const active = comments.filter((comment) => !comment.stale && comment.body.trim());
  if (!active.length) return "";
  const rows = active.map((comment) => {
    const body = comment.body.trim().slice(0, 4_000);
    const excerpt = comment.excerpt.trim().slice(0, 240);
    return `**${comment.filePath} · ${reviewCommentLineLabel(comment)}**${excerpt ? `\n\n> ${excerpt.replace(/\n/g, "\n> ")}` : ""}\n\n${body}`;
  });
  return `Please address this review feedback:\n\n${rows.join("\n\n---\n\n")}`.slice(0, 24_000);
}

export function appendReviewFeedback(prompt: string, comments: ReviewCommentDraft[]): string {
  const feedback = serializeReviewComments(comments);
  if (!feedback) return prompt;
  if (prompt.includes(feedback)) return prompt;
  return prompt.trim() ? `${prompt.trimEnd()}\n\n${feedback}` : feedback;
}
