import React, { useEffect, useRef, useState } from "react";

import type { BackendContextBreakdown } from "../shared/backendEvents";
import type { ContextMeterState, ContextUsageEstimate } from "../shared/contextWindow";

const stateLabel: Record<ContextMeterState, string> = {
  measured: "Measured",
  estimated: "Estimated",
  recalculating: "Recalculating",
};

/// The panel reports finer amounts than the ring's tooltip, so it carries one
/// decimal where the compact badge rounds.
function formatPanelTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

type ContextMeterRow = { key: string; label: string; tokens: number; note?: string };

function categoryRows(
  estimate: ContextUsageEstimate,
  breakdown: BackendContextBreakdown | undefined,
  draftTokens: number,
): ContextMeterRow[] {
  // Without a runner breakdown the only thing known about the protected prefix
  // is the reserve held for it, so the row says so rather than claiming a size.
  const systemNote = breakdown ? (breakdown.systemPromptExact ? "measured" : undefined) : "reserved";
  const rows: ContextMeterRow[] = [
    { key: "conversation", label: "Messages", tokens: breakdown?.conversationTokens ?? 0 },
    { key: "toolResults", label: "Tool results", tokens: breakdown?.toolResultTokens ?? 0 },
    { key: "tools", label: "Tool definitions", tokens: breakdown?.toolDefinitionTokens ?? 0 },
    { key: "skills", label: "Skills", tokens: breakdown?.skillTokens ?? 0 },
    { key: "images", label: "Images", tokens: breakdown?.imageTokens ?? 0 },
    { key: "system", label: "System prompt", tokens: breakdown?.systemPromptTokens ?? estimate.protectedTokens, note: systemNote },
    { key: "draft", label: "Draft & attachments", tokens: draftTokens },
    { key: "reserve", label: "Output reserve", tokens: estimate.reserveTokens },
  ];
  rows.sort((left, right) => right.tokens - left.tokens);
  return [
    ...rows.filter((row) => row.tokens > 0),
    { key: "free", label: "Free space", tokens: Math.max(0, estimate.contextLength - estimate.estimatedTokens) },
  ];
}

export function ContextMeter({
  estimate,
  state,
  breakdown,
  draftTokens,
  compactionBlocked,
  compacting,
}: {
  estimate: ContextUsageEstimate;
  state: ContextMeterState;
  breakdown?: BackendContextBreakdown;
  draftTokens: number;
  compactionBlocked?: boolean;
  /// True while a summarization pass is rewriting the prefix. Everything on the
  /// ring describes the conversation as it was before that pass, so the meter
  /// says it is busy rather than presenting a number that is already stale.
  compacting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const displayedPercentage = Math.min(100, Math.max(0, estimate.percentage));
  const roundedPercentage = Math.round(estimate.percentage);
  const used = `${formatPanelTokens(estimate.estimatedTokens)} / ${formatPanelTokens(estimate.contextLength)}`;
  const rows = categoryRows(estimate, breakdown, draftTokens);
  const share = (tokens: number) =>
    estimate.contextLength > 0 ? (tokens / estimate.contextLength) * 100 : 0;

  return (
    <div className="contextMeter" ref={container}>
      <button
        type="button"
        className={`contextMeterButton is-${estimate.level}${state === "recalculating" ? " is-stale" : ""}${compacting ? " is-compacting" : ""}`}
        aria-label={
          compacting
            ? `Compacting context. Last known use: ${used}, ${roundedPercentage}%.`
            : `${stateLabel[state]} context use: ${used}, ${roundedPercentage}%.`
        }
        aria-busy={compacting || undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle className="contextMeterTrack" cx="12" cy="12" r="9" pathLength="100" />
          <circle
            className="contextMeterValue"
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            strokeDasharray={`${displayedPercentage} 100`}
          />
        </svg>
      </button>
      <div className={`contextMeterPanel${open ? " is-open" : ""}`} role="dialog" aria-label="Context window">
        <div className="contextMeterTitle">
          <span>Context window</span>
          <b>{used} ({roundedPercentage}%)</b>
        </div>
        <div className="contextMeterBar" aria-hidden="true">
          {rows
            .filter((row) => row.key !== "free")
            .map((row) => (
              <i key={row.key} className={`is-${row.key}`} style={{ width: `${share(row.tokens)}%` }} />
            ))}
        </div>
        {/* While it runs, the in-flight notice is the whole story: the
            "compacted, awaiting measurement" note describes the pass that
            already finished and would contradict it. */}
        {compacting ? (
          <span className="contextMeterNotice is-busy">
            Compacting earlier context. This takes a few seconds, and the next response starts from a cold prefix.
          </span>
        ) : state === "recalculating" ? (
          <span className="contextMeterNotice">Context was compacted. The next response re-measures it.</span>
        ) : null}
        {compactionBlocked ? (
          <span className="contextMeterNotice">Context is at its incompressible floor.</span>
        ) : null}
        {/* Per-category estimates over a measured total. They are not
            reconciled to the headline, and the heading says so. */}
        <span className="contextMeterRowsTitle">
          {state === "measured" ? "Estimated usage by category" : "Estimated usage by category (no measurement yet)"}
        </span>
        <ul className="contextMeterRows">
          {rows.map((row) => (
            <li key={row.key}>
              <i className={`contextMeterSwatch is-${row.key}`} aria-hidden="true" />
              <span>
                {row.label}
                {row.note ? <em> ({row.note})</em> : null}
              </span>
              <b>{formatPanelTokens(row.tokens)}</b>
              <u>{share(row.tokens).toFixed(1)}%</u>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
