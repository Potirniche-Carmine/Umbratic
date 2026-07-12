import React, { useMemo } from "react";
import type { DiffCell, ReviewFile, SideBySideRow } from "../../shared/reviewDiff";
import { alignHunk } from "../../shared/reviewDiff";
import { DiffRow, type ReviewLineSelection } from "./DiffRow";

export function DiffFileView({
  file,
  viewMode,
  wrap,
  commenting,
  selection,
  onSelect,
  editor,
}: {
  file: ReviewFile;
  viewMode: "split" | "unified";
  wrap: boolean;
  commenting: boolean;
  selection: ReviewLineSelection | null;
  onSelect(event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell, row: SideBySideRow): void;
  editor: React.ReactNode;
}) {
  const hunks = useMemo(() => file.hunks.map((hunk) => ({ hunk, rows: alignHunk(hunk) })), [file]);
  if (file.binary || file.tooLarge || !file.hunks.length) {
    return (
      <div className="reviewDiffEmpty">
        <strong>{file.binary ? "Binary file changed" : file.tooLarge ? "Diff is too large to render" : "No text diff available"}</strong>
        <span>{file.binary ? "The file is included in the review, but has no line-level preview." : "Open the file in your editor to inspect it."}</span>
      </div>
    );
  }
  return (
    <div className={`reviewDiffCanvas mode-${viewMode} ${wrap ? "isWrapped" : ""} ${commenting ? "isCommenting" : ""}`}>
      <div className="reviewDiffColumnHeaders" aria-hidden="true">
        <span>Before</span><span>After</span>
      </div>
      {hunks.map(({ hunk, rows }) => (
        <section className="reviewHunk" id={`review-hunk-${hunk.id}`} key={hunk.id}>
          {viewMode === "split" ? rows.map((row) => (
            <React.Fragment key={row.id}>
              <DiffRow row={row} selection={selection} commenting={commenting} onSelect={onSelect} />
              {selection?.rowId === row.id ? editor : null}
            </React.Fragment>
          )) : rows.flatMap((row) => {
            const cells = row.kind === "context" ? [row.right] : [row.left, row.right].filter((cell) => cell.origin !== "empty");
            return cells.map((cell) => {
              const unifiedRow: SideBySideRow = cell.side === "old"
                ? { ...row, left: cell, right: { side: "new", line: null, content: "", origin: "empty" } }
                : { ...row, left: { side: "old", line: null, content: "", origin: "empty" }, right: cell };
              const key = `${row.id}-${cell.side}`;
              return (
                <React.Fragment key={key}>
                  <DiffRow row={unifiedRow} selection={selection} commenting={commenting} onSelect={onSelect} />
                  {selection?.rowId === row.id && selection.side === cell.side ? editor : null}
                </React.Fragment>
              );
            });
          })}
        </section>
      ))}
    </div>
  );
}
