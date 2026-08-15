import { ChevronRight, ExternalLink, FileText, Loader2, X } from "lucide-react";
import type { SkillInfo } from "../shared/desktopApi";
import { skillGovernanceLabel } from "./skillDisplay";
import type { ReviewFile } from "./rendererTypes";

export function documentReviewDisplayName(filePath: string): string {
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const stem = fileName.replace(/\.docx$/i, "");
  const title = stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return title || fileName;
}

export function SkillGovernance({ skill }: { skill: SkillInfo }) {
  const label = skillGovernanceLabel(skill);
  if (!label) return null;
  return <span className={`skillGovernance ${label === "Modified" ? "isModified" : ""}`}>{label}</span>;
}

/**
 * One line at the end of a turn saying how much changed, and nothing else. The
 * file list lives in the review panel this opens: printing it twice made the
 * composer scroll for a summary, and the panel is where the paths are
 * clickable anyway.
 */
export function ReviewSummaryCard({
  fileCount,
  onOpenReview,
  totals,
}: {
  fileCount: number;
  onOpenReview(): void;
  totals: { additions: number; deletions: number };
}) {
  if (!fileCount) return null;
  return (
    <article className="reviewSummaryCard">
      <button className="reviewSummaryHeader" type="button" onClick={onOpenReview}>
        <span className="reviewSummaryTitle">
          <FileText size={15} />
          <strong>
            {fileCount} file{fileCount === 1 ? "" : "s"} changed
          </strong>
          <span className="additions">+{totals.additions}</span>
          <span className="deletions">-{totals.deletions}</span>
        </span>
        <span className="reviewSummaryReviewButton">
          <span>Review</span>
          <ExternalLink size={13} />
        </span>
      </button>
    </article>
  );
}

export function DocumentReviewResponseLink({
  file,
  onOpenReview,
}: {
  file: ReviewFile;
  onOpenReview(filePath: string): void;
}) {
  const fileName = file.path.replace(/\\/g, "/").split("/").pop() ?? file.path;
  return (
    <button
      className="documentResponseLink"
      type="button"
      onClick={() => onOpenReview(file.path)}
      aria-label={`Review ${documentReviewDisplayName(file.path)} document`}
    >
      <span className="documentResponseIcon"><FileText size={17} aria-hidden="true" /></span>
      <span className="documentResponseIdentity">
        <strong>{documentReviewDisplayName(file.path)}</strong>
        <small>{fileName}</small>
      </span>
      <span className="documentResponseAction">Review <ChevronRight size={13} aria-hidden="true" /></span>
    </button>
  );
}

export function ComposerGreeting({ label }: { label: string }) {
  return (
    <div className="composerGreeting">
      <span>{label}</span>
    </div>
  );
}

/**
 * Weights being read into memory, while it is happening.
 *
 * Picking a model in the prompt box — or pressing the microphone, which loads
 * the speech model on the press — starts a load that takes as long as it takes
 * to read gigabytes off disk. The only sign of either used to be a spinner
 * inside the control that started it, which on a 26px button is no sign at
 * all: the app simply looked hung. So it says so where the user is looking, a
 * card at the top of the window, naming what is loading and offering the way
 * out, because a load nobody can stop is the worst version of this.
 *
 * Cancel abandons the load; the close button only hides the card and the load
 * carries on.
 */
export function ModelStartupNotice({
  title,
  detail,
  onCancel,
  onDismiss,
}: {
  title: string;
  detail: string;
  onCancel(): void;
  onDismiss(): void;
}) {
  return (
    <div className="modelStartupNotice" role="status" aria-live="polite">
      <Loader2 className="spin" size={16} aria-hidden="true" />
      <div className="modelStartupText">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button className="modelStartupCancel" type="button" onClick={onCancel}>
        Cancel
      </button>
      <button className="modelStartupDismiss" type="button" onClick={onDismiss} aria-label="Hide this notice">
        <X size={14} />
      </button>
    </div>
  );
}
