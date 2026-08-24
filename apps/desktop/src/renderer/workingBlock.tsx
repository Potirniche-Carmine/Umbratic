import { ChevronDown, ChevronRight, Sparkles, SquareTerminal } from "lucide-react";
import type { Dispatch, MutableRefObject, PointerEvent, SetStateAction, TouchEvent, UIEvent, WheelEvent } from "react";
import type { SkillInfo } from "../shared/desktopApi";
import { activityHasNarration, activityHasTools, activitySummary } from "./activityTiming";
import {
  activityToolLabel,
  commandHasVisibleDetails,
  commandLiveOutputPreview,
  commandShellText,
} from "./commandDisplay";
import { WorkMarkdownContent } from "./markdownContent";
import type { ComposerTimelineItem } from "./rendererTypes";

type ActivityItem = Extract<ComposerTimelineItem, { type: "activity" }>;

type WorkingBlockProps = {
  item: ActivityItem;
  clock: number;
  expanded: boolean;
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

export function WorkingBlock({
  item,
  clock,
  expanded,
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
      className={`timelineActivity ${item.finished ? "isFinished" : "isGenerating"} ${expanded ? "isExpanded" : ""}`}
    >
      <button
        className="activityHeader"
        type="button"
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
        </span>
        <ChevronRight className="activityChevron" size={13} />
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
            {item.segments.map((segment) => {
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
                case "skill": {
                  const skillName = skills.find((skill) => skill.id === segment.skillId)?.name ?? segment.skillId;
                  return (
                    <section className="activityLogEntry skillLog" key={segment.id}>
                      <Sparkles size={12} aria-hidden="true" />
                      <span>Skill</span>
                      <strong>{skillName}</strong>
                    </section>
                  );
                }
                case "command": {
                  const { label } = activityToolLabel(segment.run);
                  const toolDisclosureId = `${item.id}:${segment.id}`;
                  const toolExpanded = expandedToolIds.has(toolDisclosureId);
                  const hasVisibleDetails = commandHasVisibleDetails(segment.run);
                  const liveOutput = toolExpanded ? undefined : commandLiveOutputPreview(segment.run);
                  const toolLabelContent = (
                    <>
                      <SquareTerminal className="activityToolKindIcon" size={11} aria-hidden="true" />
                      <span title={segment.run.command}>{label}</span>
                    </>
                  );
                  return (
                    <section
                      className={`activityLogEntry commandLog ${segment.run.status} ${
                        toolExpanded ? "isExpanded" : ""
                      }`}
                      key={segment.id}
                    >
                      {hasVisibleDetails ? (
                        <button
                          className="activityToolToggle"
                          type="button"
                          onClick={() => setExpandedTools(toggleId(toolDisclosureId))}
                          aria-expanded={toolExpanded}
                        >
                          {toolLabelContent}
                          {toolExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                      ) : (
                        <div className="activityToolToggle activityToolStatic">
                          {toolLabelContent}
                        </div>
                      )}
                      {liveOutput ? <pre className="activityLiveOutput" aria-live="polite">{liveOutput}</pre> : null}
                      {hasVisibleDetails && toolExpanded ? (
                        <div className="activityToolGroupDetails">
                          <div>
                            <pre>{commandShellText(segment.run)}</pre>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  );
                }
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
