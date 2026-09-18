import React from "react";
import type { DiffCell, DiffSide, SideBySideRow } from "../../shared/reviewDiff";

export type ReviewLineSelection = {
  hunkId: string;
  side: DiffSide;
  lines: number[];
};

function DiffCode({ cell }: { cell: DiffCell }) {
  if (cell.origin === "empty") return <code aria-hidden="true"> </code>;
  // Spans only reach here when the alignment was worth showing, so a changed
  // span is marked on that basis alone. The extra "does anything survive?"
  // check this used to make was a third gate on top of two others, and it
  // silently downgraded whole rows to no highlighting at all.
  return (
    <code>
      {cell.spans?.length
        ? cell.spans.map((span, index) => (
            <mark className={span.changed && span.text.trim() ? "intraLineChange" : "intraLineSame"} key={index}>{span.text}</mark>
          ))
        : cell.content || " "}
    </code>
  );
}

function DiffCellView({
  cell,
  selectable,
  selected,
  commenting,
  onSelect,
}: {
  cell: DiffCell;
  selectable: boolean;
  selected: boolean;
  commenting: boolean;
  onSelect(event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell): void;
}) {
  // The line itself is the target, not just its number: aiming at a 50px
  // gutter to say something about the text beside it is a needlessly small
  // hit area. A click that ends a text selection is still a copy, though.
  const pickLine = (event: React.MouseEvent) => {
    if (!commenting || !selectable) return;
    if (window.getSelection()?.isCollapsed === false) return;
    onSelect(event, cell);
  };
  return (
    <div
      className={`reviewDiffCell ${cell.side} origin-${cell.origin} ${selected ? "isSelected" : ""} ${commenting && selectable ? "isPickable" : ""}`}
      onClick={pickLine}
      role="presentation"
    >
      {cell.line !== null && cell.origin !== "empty" ? (
        <button
          className="reviewLineGutter"
          type="button"
          disabled={!commenting || !selectable}
          onClick={(event) => { event.stopPropagation(); onSelect(event, cell); }}
          aria-label={commenting ? `Comment on ${cell.side} line ${cell.line}` : `${cell.side} line ${cell.line}`}
          title={commenting && selectable ? `Select ${cell.side} line ${cell.line} for feedback` : undefined}
        >
          <span>{cell.line}</span>
        </button>
      ) : <span className="reviewLineGutter isEmpty" />}
      <DiffCode cell={cell} />
    </div>
  );
}

function DiffRowComponent({
  row,
  selection,
  commenting,
  onSelect,
}: {
  row: SideBySideRow;
  selection: ReviewLineSelection | null;
  commenting: boolean;
  onSelect(event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell, row: SideBySideRow): void;
}) {
  const isSelected = (cell: DiffCell) => !!selection && selection.hunkId === row.hunkId && selection.side === cell.side && cell.line !== null && selection.lines.includes(cell.line);
  // Any real line on either side, in both layouts. Side by side used to accept
  // the new side only, on the grounds that a deleted line has nothing left to
  // attach to — but unified accepted those same deletions, so the rule only
  // ever made half of one layout swallow clicks in silence. Nothing about the
  // armed mode said which half, which is what made feedback feel broken.
  const canSelect = (cell: DiffCell) => cell.line !== null && cell.origin !== "empty";
  return (
    <div className={`reviewDiffRow kind-${row.kind}`} data-row-id={row.id}>
      <DiffCellView cell={row.left} selectable={canSelect(row.left)} selected={isSelected(row.left)} commenting={commenting} onSelect={(event, cell) => onSelect(event, cell, row)} />
      <DiffCellView cell={row.right} selectable={canSelect(row.right)} selected={isSelected(row.right)} commenting={commenting} onSelect={(event, cell) => onSelect(event, cell, row)} />
    </div>
  );
}

function cellIsSelected(selection: ReviewLineSelection | null, row: SideBySideRow, cell: DiffCell): boolean {
  return !!selection
    && selection.hunkId === row.hunkId
    && selection.side === cell.side
    && cell.line !== null
    && selection.lines.includes(cell.line);
}

export const DiffRow = React.memo(DiffRowComponent, (previous, next) => (
  previous.row === next.row
  && previous.commenting === next.commenting
  && previous.onSelect === next.onSelect
  && cellIsSelected(previous.selection, previous.row, previous.row.left) === cellIsSelected(next.selection, next.row, next.row.left)
  && cellIsSelected(previous.selection, previous.row, previous.row.right) === cellIsSelected(next.selection, next.row, next.row.right)
));
