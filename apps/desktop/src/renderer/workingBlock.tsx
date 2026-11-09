import { ChevronRight } from "lucide-react";
import { ActivityTools } from "./ActivityTools";
import { groupActivitySegments } from "./activityPresentation";
import type { Dispatch, MutableRefObject, PointerEvent, SetStateAction, TouchEvent, UIEvent, WheelEvent } from "react";
import type { SkillInfo } from "../shared/desktopApi";
import { activityHasNarration, activityHasTools, activitySummary } from "./activityTiming";
import { activityToolLabel } from "./commandDisplay";
import { WorkMarkdownContent } from "./markdownContent";
import type { ComposerTimelineItem } from "./rendererTypes";

type ActivityItem = Extract<ComposerTimelineItem, { type: "activity" }>;

type WorkingBlockProps = {
  item: ActivityItem;
  clock: number;
  expanded: boolean;
  expandWhileRunning?: boolean;
  expandedToolIds: Set<string>;
  skills: SkillInfo[];
  followScrollRef: MutableRefObject<Map<string, boolean>>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  setExpandedTools: Dispatch<SetStateAction<Set<string>>>;
  setBodyRef: (id: string, node: HTMLDivElement | null) => void;
  onPointerDown: (id: string, event: PointerEvent<HTMLDivElement>) => void;
  onScroll: (id: string, event: UIEvent<HTMLDivElement>) => void;
  onTouchMove: (id: string, event: TouchEvent<HTMLDivElement>) => void;
  onWheel: (id: string, event: WheelEvent<HTMLDivElement>) => void;
};

function toggleId(id: string): (current: Set<string>) => Set<string> {
  return (current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
}

/**
 * What the collapsed row says the run is doing right now: the newest thing in
 * the log with a name. Blocks are shut by default, so while the run is live
 * this line is the reader's only signal beyond "Working" — it names the
 * current tool, skill, or thinking passage without asking them to open the
 * log to find out.
 */
function liveActivityHint(segments: ActivityItem["segments"], skills: SkillInfo[]): string | null {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.type === "command") return activityToolLabel(segment.run).label;
    if (segment.type === "skill") return skills.find((skill) => skill.id === segment.skillId)?.name ?? segment.skillId;
    if (segment.type === "reasoning" && segment.kind === "thinking") return "Thinking";
  }
  return null;
}

export function WorkingBlock({
  item,
  clock,
  expanded: manuallyExpanded,
  expandWhileRunning = true,
  expandedToolIds,
  skills,
  followScrollRef,
  setExpanded,
  setExpandedTools,
  setBodyRef,
  onPointerDown,
  onScroll,
  onTouchMove,
  onWheel,
}: WorkingBlockProps) {
  const lockedOpen = expandWhileRunning && !item.finished;
  const expanded = lockedOpen || manuallyExpanded;

  const hasTools = activityHasTools(item.segments);
  // The bare status line is for a block with nothing in it yet — the wait
  // before the run has said anything. Once it holds narration there is
  // something to read, so it takes the ordinary expandable shape instead of
  // throwing its own segments away.
  if (!item.finished && !hasTools && !activityHasNarration(item.segments)) {
    return (
      <article className="timelineActivity isGenerating isStatusOnly">
        <div className="activityHeader" role="status">
          <span className="activityHeaderText">
            <strong>
              {activitySummary(item, clock)}
              <span className="activityDots" aria-hidden="true">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </strong>
          </span>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`timelineActivity ${item.finished ? "isFinished" : "isGenerating"} ${expanded ? "isExpanded" : ""} ${lockedOpen ? "isLockedOpen" : ""}`}
    >
      <button
        className="activityHeader"
        type="button"
        disabled={lockedOpen}
        onClick={() => {
          if (!expanded) followScrollRef.current.set(item.id, true);
          setExpanded(toggleId(item.id));
        }}
        aria-expanded={expanded}
      >
        <span className="activityHeaderText">
          <strong>
            {activitySummary(item, clock)}
            {!item.finished ? (
              <span className="activityDots" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            ) : null}
          </strong>
          {!expanded && !item.finished ? (
            (() => {
              const hint = liveActivityHint(item.segments, skills);
              return hint ? <span className="activityHeaderHint">{hint}</span> : null;
            })()
          ) : null}
        </span>
        {!lockedOpen && <ChevronRight className="activityChevron" size={13} />}
      </button>
      <div className={`activityBody ${expanded ? "open" : ""}`} aria-hidden={!expanded}>
        <div
          className="activityBodyInner"
          ref={(node) => setBodyRef(item.id, node)}
          onPointerDown={(event) => onPointerDown(item.id, event)}
          onScroll={(event) => onScroll(item.id, event)}
          onTouchMove={(event) => onTouchMove(item.id, event)}
          onWheel={(event) => onWheel(item.id, event)}
        >
          <div className="activityBodyContent">
            {groupActivitySegments(item.segments).map((segment) => {
              switch (segment.type) {
                case "reasoning":
                  return (
                    <section
                      className={`activityLogEntry reasoningLog ${segment.kind === "thinking" ? "isThinking" : ""} ${segment.finished ? "" : "isStreaming"}`}
                      key={segment.id}
                    >
                      {segment.kind === "thinking" ? <span className="activityThinkingLabel">Thinking</span> : null}
                      <WorkMarkdownContent content={segment.text.trim()} streaming={!item.finished && !segment.finished} />
                    </section>
                  );
                case "tools":
                  return <ActivityTools key={segment.id} group={segment} itemId={item.id} finished={item.finished} skills={skills} expandedToolIds={expandedToolIds} setExpandedTools={setExpandedTools}/>;
                default: {
                  const exhaustive: never = segment;
                  return exhaustive;
                }
              }
            })}
          </div>
        </div>
      </div>
    </article>
  );
}
