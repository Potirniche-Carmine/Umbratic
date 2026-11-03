import React, { useRef } from "react";
import type { CloudUsage as Usage, CloudWorkspace } from "../../shared/cloud";

export function CloudUsageDetails({ usage }: { usage?: Usage }) {
  if (!usage?.limits.length) return <p className="cloudUsageUnavailable">Usage limits aren’t available from this runtime.</p>;
  return <div className="cloudUsageDetails">{usage.limits.map(limit => <div className="cloudUsageWindow" key={limit.id}>
    <div><span>{limit.label}</span><strong>{Math.round(100 - limit.usedPercent)}% left</strong></div>
    <meter min={0} max={100} value={100 - limit.usedPercent} aria-label={`${limit.label} remaining`}/>
    {limit.resetsAt && <small>Resets {new Date(limit.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>}
  </div>)}<small className="cloudUsageUpdated">Updated {new Date(usage.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div>;
}
export function CloudUsageIndicator({ workspace, usage }: { workspace: CloudWorkspace | null; usage?: Usage }) {
  const popover = useRef<HTMLDivElement>(null);
  const contextKnown = !!workspace?.contextWindow && typeof workspace.inputTokens === "number";
  const percent = contextKnown ? Math.min(100, Math.round(workspace!.inputTokens! / workspace!.contextWindow! * 100)) : undefined;
  const latest = workspace?.usage && (!usage || workspace.usage.fetchedAt > usage.fetchedAt) ? workspace.usage : usage;
  return <>
    <button type="button" className="cloudUsageTrigger" aria-label="Context and usage" onClick={event => {
      const element = popover.current!;
      if (element.matches(":popover-open")) { element.hidePopover(); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 300))}px`;
      element.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      element.showPopover();
    }}>{latest?.limits[0] ? `${Math.round(100 - latest.limits[0].usedPercent)}% usage left` : "Usage"}<span>·</span>{percent === undefined ? "Context" : `${percent}% context`}</button>
    <div ref={popover} popover="auto" className="cloudUsagePopover">
      <div className="cloudContextUsage"><strong>Context{contextKnown && workspace?.provider === "claude" ? " · estimated" : ""}</strong><span>{contextKnown ? `${workspace!.inputTokens!.toLocaleString()} / ${workspace!.contextWindow!.toLocaleString()}` : "Available after your first turn"}</span>{contextKnown && <meter min={0} max={100} value={percent} aria-label="Context used"/>}</div>
      <CloudUsageDetails usage={latest}/>
    </div>
  </>;
}
