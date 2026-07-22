import React from "react";
import type { DiffCell, DiffSide, SideBySideRow } from "../../shared/reviewDiff";

export type ReviewLineSelection = {
  hunkId: string;
  side: DiffSide;
  lines: number[];
  rowId: string;
};

function DiffCode({ cell }: { cell: DiffCell }) {
  if (cell.origin === "empty") return <code aria-hidden="true"> </code>;
  const showIntraLineChanges = cell.spans?.some((span) => !span.changed && span.text.trim());
  return (
    <code>
      {cell.spans?.length
        ? cell.spans.map((span, index) => (
            <mark className={span.changed && showIntraLineChanges && span.text.trim() ? "intraLineChange" : "intraLineSame"} key={index}>{span.text}</mark>
          ))
        : cell.content || " "}
    </code>
  );
}

function DiffCellView({
  cell,
  selected,
  commenting,
  onSelect,
}: {
  cell: DiffCell;
  selected: boolean;
  commenting: boolean;
  onSelect(event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell): void;
}) {
  const selectable = cell.line !== null && cell.origin !== "empty";
  return (
    <div className={`reviewDiffCell ${cell.side} origin-${cell.origin} ${selected ? "isSelected" : ""}`}>
      {selectable ? (
        <button
          className="reviewLineGutter"
          type="button"
          disabled={!commenting}
          onClick={(event) => onSelect(event, cell)}
          aria-label={commenting ? `Comment on ${cell.side} line ${cell.line}` : `${cell.side} line ${cell.line}`}
          title={commenting ? `Select ${cell.side} line ${cell.line} for feedback` : undefined}
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
  return (
    <div className={`reviewDiffRow kind-${row.kind}`} data-row-id={row.id}>
      <DiffCellView cell={row.left} selected={isSelected(row.left)} commenting={commenting} onSelect={(event, cell) => onSelect(event, cell, row)} />
      <DiffCellView cell={row.right} selected={isSelected(row.right)} commenting={commenting} onSelect={(event, cell) => onSelect(event, cell, row)} />
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
