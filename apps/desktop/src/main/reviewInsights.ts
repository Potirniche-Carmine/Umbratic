import * as fs from "node:fs";
import * as path from "node:path";

import { analyzeWorkspaceChanges, workspaceGraphArtifactPath } from "./indexerService";
import type { ReviewFile } from "../shared/reviewDiff";

/**
 * Review priority. The ordering the user sees and the ordering the model is
 * given both come from this one file, so they can never disagree.
 *
 * Everything here fails toward today's behaviour: no insights, stale insights,
 * or unreadable insights all leave the review panel on its existing path
 * ordering with no caption.
 */

export type ReviewInsights = {
  patchHash: string;
  overallRisk: number;
  fileOrder: string[];
};

export function insightsPath(workspacePath: string): string {
  return path.join(path.dirname(workspaceGraphArtifactPath(workspacePath)), "insights.json");
}

/**
 * Reads insights only when they describe the diff currently being shown.
 * A hash mismatch means the analysis is for a different patch, which would
 * order the panel by facts about code the user is not looking at.
 */
export function readReviewInsights(workspacePath: string, patchHash: string): ReviewInsights | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(insightsPath(workspacePath), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.patchHash !== patchHash) return null;
    if (!Array.isArray(record.fileOrder)) return null;
    return {
      patchHash,
      overallRisk: typeof record.overallRisk === "number" ? record.overallRisk : 0,
      fileOrder: record.fileOrder.filter((value): value is string => typeof value === "string"),
    };
  } catch {
    return null;
  }
}

/**
 * Highest priority first, then everything the analysis did not rank, in the
 * order it already had. A file is never dropped for being unranked.
 */
export function orderReviewFiles(files: ReviewFile[], insights: ReviewInsights | null): ReviewFile[] {
  if (!insights || insights.fileOrder.length === 0) return files;
  const rank = new Map(insights.fileOrder.map((filePath, index) => [filePath, index]));
  return [...files].sort((left, right) => {
    const leftRank = rank.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.path) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

/**
 * Runs the analysis for this patch and returns the ordered files. Keyed on the
 * patch hash by the analyzer itself, so a review refresh that changed nothing
 * re-reads rather than re-analyzes.
 */
export async function prioritizedReviewFiles(
  workspacePath: string,
  baseCommit: string,
  patchHash: string,
  files: ReviewFile[],
): Promise<{ files: ReviewFile[]; prioritized: boolean }> {
  const existing = readReviewInsights(workspacePath, patchHash);
  const insights =
    existing
    ?? ((await analyzeWorkspaceChanges(workspacePath, baseCommit, patchHash))
      ? readReviewInsights(workspacePath, patchHash)
      : null);
  if (!insights) return { files, prioritized: false };
  return { files: orderReviewFiles(files, insights), prioritized: true };
}
