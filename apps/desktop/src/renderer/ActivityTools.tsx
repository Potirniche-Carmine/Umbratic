import React, { useState, type Dispatch, type SetStateAction } from "react";
import { BookOpen, ChevronDown, ChevronRight, FilePenLine, Search, Sparkles, SquareTerminal, Wrench } from "lucide-react";
import type { SkillInfo } from "../shared/desktopApi";
import { commandHasVisibleDetails, commandShellText } from "./commandDisplay";
import { activityCommandPresentation, activityGroupSummary, visibleActivityTools, type ToolGroup } from "./activityPresentation";

export function ActivityTools({ group, itemId, finished, skills, expandedToolIds, setExpandedTools }: {
  group: ToolGroup; itemId: string; finished: boolean; skills: SkillInfo[]; expandedToolIds: Set<string>; setExpandedTools: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const grouped = group.segments.length >= 4;
  const visible = visibleActivityTools(group.segments, expanded, finished);
  return <section className={`activityTools ${grouped ? "isGrouped" : ""}`}>
    {grouped && <button type="button" className="activityGroupToggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <Wrench size={14} aria-hidden="true"/><span>{activityGroupSummary(group.segments)}</span>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>}
    {visible.map(segment => {
      if (segment.type === "skill") return <div className="activityToolRow" key={segment.id}><Sparkles size={14}/><span>Read {skills.find(skill => skill.id === segment.skillId)?.name || segment.skillId} skill</span></div>;
      const display = activityCommandPresentation(segment.run);
      const Icon = { read: BookOpen, edit: FilePenLine, search: Search, command: SquareTerminal, tool: Wrench }[display.kind];
      const id = `${itemId}:${segment.id}`;
      const showOutput = expandedToolIds.has(id);
      const details = commandHasVisibleDetails(segment.run);
      const label = <><Icon size={14} aria-hidden="true"/><span className="activityToolText" title={display.target}>
        {display.verb && <span className="activityToolVerb">{display.verb} </span>}<span className={display.kind === "command" ? "activityCommandText" : "activityTargetText"}>{display.target}</span>
      </span></>;
      return <div key={segment.id} className={`activityToolItem ${segment.run.status} ${showOutput ? "isExpanded" : ""}`}>
        {details ? <button type="button" className="activityToolRow" aria-expanded={showOutput} onClick={() => setExpandedTools(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}>
          {label}{showOutput ? <ChevronDown className="activityToolChevron" size={12}/> : <ChevronRight className="activityToolChevron" size={12}/>}</button>
          : <div className="activityToolRow">{label}</div>}
        {showOutput && details && <pre className="activityCommandOutput">{commandShellText(segment.run)}</pre>}
      </div>;
    })}
  </section>;
}
