import React from "react";
import { Layers, Loader2 } from "lucide-react";

import { compactionElapsedLabel } from "./activityTiming";
import { formatTokenCount } from "../shared/contextWindow";
import type { ComposerTimelineItem } from "./rendererTypes";

type CompactionItem = Extract<ComposerTimelineItem, { type: "compaction" }>;

/// The compaction marker in the transcript.
///
/// Compaction is the one pause in a turn with no tool row to explain it: the
/// summarization tier is a whole extra model round-trip taken before the turn's
/// real request goes out, and the rewritten prefix then costs the provider's
/// prefix cache, so the response after it starts cold. That wait is the user's,
/// so it is spelled out in the open rather than folded into a disclosure they
/// would have to open — and it stays afterwards, marking the line in scrollback
/// where the earlier turns stopped being verbatim.
export function CompactionRow({ item, clock }: { item: CompactionItem; clock: number }) {
  const elapsed = compactionElapsedLabel(item, clock);
  // Three honest states, and none of them claims a size the runner has not
  // measured yet: the freed amount is the same estimate that decided to
  // compact, on both sides, so it is reported as an approximation.
  const running = item.status === "running";
  const label = running
    ? "Currently compacting context…"
    : item.status === "compacted"
      ? "Context compacted"
      // A summarization call that came back unusable is a fault; a pass that
      // simply had nothing left to give is a fact about the conversation. They
      // read differently because they send the user to different places.
      : item.status === "failed"
        ? "Compaction failed"
        : "Context could not be compacted further";
  const detail = running
    ? "Summarizing the earlier conversation. This takes a few seconds."
    : item.status === "failed"
      ? `The conversation is unchanged${elapsed ? ` · ${elapsed}` : ""}`
      : [
          item.status === "compacted" && item.reclaimedTokens
            ? `Freed about ${formatTokenCount(item.reclaimedTokens)} tokens`
            : "",
          elapsed,
        ].filter(Boolean).join(" · ");
  return (
    <div
      className={`compactionMarker is-${item.status}`}
      role={running ? "status" : undefined}
      aria-live={running ? "polite" : undefined}
    >
      <span className="compactionMarkerBody">
        {running ? (
          <Loader2 className="compactionSpinner" size={13} aria-hidden="true" />
        ) : (
          <Layers size={13} aria-hidden="true" />
        )}
        <strong>{label}</strong>
        {detail ? <em>{detail}</em> : null}
      </span>
    </div>
  );
}
