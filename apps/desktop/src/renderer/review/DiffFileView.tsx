import React, { useEffect, useMemo, useState } from "react";
import type { DiffCell, ReviewFile, SideBySideRow } from "../../shared/reviewDiff";
import { alignHunk, emptyCell, hiddenLinesBeforeHunk } from "../../shared/reviewDiff";
import { DiffRow, type ReviewLineSelection } from "./DiffRow";

const diffRenderChunkSize = 80;
// First paint mounts a bounded number of chunks; the rest stream in during
// idle time so a five-thousand-line diff opens without a mount stall.
const initialMountedChunks = 20;
const mountedChunksPerIdleTick = 16;
const diffRowEstimatedHeight = 22;

type DiffRowEntry = {
  key: string;
  row: SideBySideRow;
};

function chunkEntries(entries: DiffRowEntry[]): DiffRowEntry[][] {
  const chunks: DiffRowEntry[][] = [];
  for (let index = 0; index < entries.length; index += diffRenderChunkSize) {
    chunks.push(entries.slice(index, index + diffRenderChunkSize));
  }
  return chunks;
}

function unifiedEntries(row: SideBySideRow): DiffRowEntry[] {
  const cells = row.kind === "context" ? [row.right] : [row.left, row.right].filter((cell) => cell.origin !== "empty");
  return cells.map((cell) => ({
    key: `${row.id}-${cell.side}`,
    row: cell.side === "old"
      ? { ...row, left: cell, right: emptyCell("new") }
      : { ...row, left: emptyCell("old"), right: cell },
  }));
}

export function DiffFileView({
  file,
  viewMode,
  wrap,
  commenting,
  selection,
  onSelect,
}: {
  file: ReviewFile;
  viewMode: "split" | "unified";
  wrap: boolean;
  commenting: boolean;
  selection: ReviewLineSelection | null;
  onSelect(event: React.MouseEvent | React.KeyboardEvent, cell: DiffCell, row: SideBySideRow): void;
}) {
  const aligned = useMemo(
    () => file.hunks.map((hunk) => ({ hunk, rows: alignHunk(hunk) })),
    [file],
  );
  // Rows are shaped for the active layout once, not on every render: stable row
  // objects are what let React.memo skip unchanged DiffRows while scrolling or
  // selecting lines, in unified mode as well as split.
  const hunks = useMemo(() => {
    let nextChunkIndex = 0;
    return aligned.map(({ hunk, rows }) => {
      const entries = viewMode === "split"
        ? rows.map((row) => ({ key: row.id, row }))
        : rows.flatMap(unifiedEntries);
      const chunks = chunkEntries(entries).map((chunk) => ({ chunk, index: nextChunkIndex++ }));
      return { hunk, chunks };
    });
  }, [aligned, viewMode]);
  const totalChunks = hunks.reduce((total, { chunks }) => total + chunks.length, 0);
  const [mountedChunks, setMountedChunks] = useState(initialMountedChunks);

  useEffect(() => {
    setMountedChunks(initialMountedChunks);
  }, [file]);

  useEffect(() => {
    if (mountedChunks >= totalChunks) return;
    const requestIdle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 32));
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = requestIdle(() => {
      setMountedChunks((current) => Math.min(totalChunks, current + mountedChunksPerIdleTick));
    });
    return () => cancelIdle(handle);
  }, [mountedChunks, totalChunks]);

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
      {hunks.map(({ hunk, chunks }, hunkIndex) => {
        const hiddenLines = hiddenLinesBeforeHunk(hunks[hunkIndex - 1]?.hunk, hunk);
        return (
          <React.Fragment key={hunk.id}>
            {hiddenLines ? (
              <div className="reviewDiffGap" role="separator" aria-label={`${hiddenLines} unchanged lines hidden`}>
                <span>{hiddenLines} unchanged line{hiddenLines === 1 ? "" : "s"} hidden</span>
              </div>
            ) : null}
            <section className="reviewHunk" id={`review-hunk-${hunk.id}`}>
              {chunks.map(({ chunk, index }) => (
                index < mountedChunks ? (
                  <div
                    className="reviewDiffChunk"
                    style={{ containIntrinsicSize: `auto ${chunk.length * diffRowEstimatedHeight}px` }}
                    key={`${hunk.id}-chunk-${index}`}
                  >
                    {chunk.map((entry) => (
                      <DiffRow key={entry.key} row={entry.row} selection={selection} commenting={commenting} onSelect={onSelect} />
                    ))}
                  </div>
                ) : (
                  <div
                    className="reviewDiffChunk isPending"
                    style={{ height: `${chunk.length * diffRowEstimatedHeight}px` }}
                    key={`${hunk.id}-chunk-${index}`}
                    aria-hidden="true"
                  />
                )
              ))}
            </section>
          </React.Fragment>
        );
      })}
    </div>
  );
}
