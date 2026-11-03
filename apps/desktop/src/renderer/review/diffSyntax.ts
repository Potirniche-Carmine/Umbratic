import type { ReviewFile, DiffCell, DiffSide } from "../../shared/reviewDiff";
import type { SyntaxDocument, SyntaxResults, SourceToken } from "../syntaxTypes";

type DiffSyntaxSection = { hunkId: string; side: DiffSide; numbers: (number | null)[]; document: SyntaxDocument };
export function diffSyntaxSections(file: ReviewFile): DiffSyntaxSection[] {
  // Missing unchanged lines must not carry a string/comment state from one
  // distant hunk into the next. Each before/after excerpt is its own document.
  return file.hunks.flatMap(hunk => (["old", "new"] as const).map(side => {
    const lines = hunk.lines.filter(line => side === "old" ? line.origin !== "addition" : line.origin !== "deletion");
    return { hunkId: hunk.id, side, numbers: lines.map(line => side === "old" ? line.oldLine : line.newLine),
      document: { path: side === "old" ? file.oldPath || file.path : file.path, text: lines.map(line => line.content).join("\n") } };
  }));
}
export function diffSyntaxKey(hunkId: string, cell: Pick<DiffCell, "side" | "line">) { return `${hunkId}:${cell.side}:${cell.line}`; }
export function mapDiffSyntax(sections: DiffSyntaxSection[], highlights: SyntaxResults | null): Map<string, SourceToken[]> {
  const map = new Map<string, SourceToken[]>();
  sections.forEach((section, index) => section.numbers.forEach((line, offset) => {
    const tokens = highlights?.[index]?.lines[offset];
    if (line !== null && tokens) map.set(diffSyntaxKey(section.hunkId, { side: section.side, line }), tokens);
  }));
  return map;
}
