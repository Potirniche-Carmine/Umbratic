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

export type ReviewFeedbackReference = {
  filePath: string;
  lineLabel: string;
  body: string;
  excerpt: string;
};

export type VisibleReviewPrompt = {
  text: string;
  feedback: ReviewFeedbackReference[];
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

export function visibleReviewPrompt(value: string): VisibleReviewPrompt {
  const marker = "Please address this review feedback:";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex < 0 || (markerIndex > 0 && !value.slice(0, markerIndex).endsWith("\n\n"))) {
    return { text: value, feedback: [] };
  }
  const serialized = value.slice(markerIndex + marker.length);
  if (!serialized.startsWith("\n\n")) return { text: value, feedback: [] };
  const rows = serialized.slice(2).split("\n\n---\n\n");
  const feedback: ReviewFeedbackReference[] = [];
  for (const row of rows) {
    const firstBreak = row.indexOf("\n\n");
    const heading = firstBreak >= 0 ? row.slice(0, firstBreak) : row;
    const match = heading.match(/^\*\*(.+) · (Lines .+)\*\*$/);
    if (!match || firstBreak < 0) return { text: value, feedback: [] };
    let remainder = row.slice(firstBreak + 2);
    let excerpt = "";
    if (remainder.startsWith("> ")) {
      const excerptEnd = remainder.indexOf("\n\n");
      if (excerptEnd < 0) return { text: value, feedback: [] };
      excerpt = remainder.slice(0, excerptEnd).replace(/^> ?/gm, "");
      remainder = remainder.slice(excerptEnd + 2);
    }
    const body = remainder.trim();
    if (!body) return { text: value, feedback: [] };
    feedback.push({ filePath: match[1], lineLabel: match[2], body, excerpt });
  }
  return feedback.length
    ? { text: value.slice(0, markerIndex).trimEnd(), feedback }
    : { text: value, feedback: [] };
}
