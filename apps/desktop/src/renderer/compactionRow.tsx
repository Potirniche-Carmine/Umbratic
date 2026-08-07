import React from "react";
import { Layers, Loader2 } from "lucide-react";

import { compactionElapsedLabel } from "./activityTiming";
import { formatTokenCount } from "../shared/contextWindow";
import type { ComposerActivitySegment } from "./rendererTypes";

type CompactionSegment = Extract<ComposerActivitySegment, { type: "compaction" }>;

/// The compaction row inside the Working block.
///
/// Compaction is the one pause in a turn with no tool row to explain it: the
/// summarization tier is a whole extra model round-trip taken before the turn's
/// real request goes out, and the rewritten prefix then costs the provider's
/// prefix cache, so the response after it starts cold. This row is what turns
/// that wait from unexplained silence into visible work.
export function CompactionRow({ segment, clock }: { segment: CompactionSegment; clock: number }) {
  const elapsed = compactionElapsedLabel(segment, clock);
  // Three honest states, and none of them claims a size the runner has not
  // measured yet: the freed amount is the same estimate that decided to
  // compact, on both sides, so it is reported as an approximation.
  const label = segment.status === "running"
    ? "Compacting context"
    : segment.status === "compacted"
      ? "Compacted context"
      : "Context could not be compacted further";
  const freed = segment.status === "compacted" && segment.reclaimedTokens
    ? `freed about ${formatTokenCount(segment.reclaimedTokens)} tokens`
    : "";
  return (
    <section className={`activityLogEntry compactionLog is-${segment.status}`}>
      {segment.status === "running" ? (
        <Loader2 className="compactionSpinner" size={12} aria-hidden="true" />
      ) : (
        <Layers size={12} aria-hidden="true" />
      )}
      <span>{label}</span>
      <em>{[freed, elapsed].filter(Boolean).join(" · ")}</em>
    </section>
  );
}
