import React, { useId, useRef, useState } from "react";
import type { CloudUsage as Usage, CloudWorkspace } from "../../shared/cloud";

function tone(used?: number, severity?: string) {
  if (severity) return severity === "critical" ? "critical" : severity === "warning" ? "warning" : severity === "normal" ? "normal" : "unknown";
  return used === undefined ? "unknown" : used >= 90 ? "critical" : used >= 70 ? "warning" : "normal";
}
function UsageRing({ value, used, severity, compact = false }: { value?: number; used?: number; severity?: string; compact?: boolean }) {
  return <span className={`cloudUsageRing ${compact ? "isCompact" : ""} is-${tone(used, severity)}`} aria-hidden="true">
    <svg viewBox="0 0 48 48"><circle className="cloudRingTrack" cx="24" cy="24" r="20"/>{value !== undefined && value > 0 && <circle className="cloudRingValue" cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, value))} 100`}/>}</svg>
    {!compact && <span>{value === undefined ? "—" : Math.round(value)}{value !== undefined && <small>%</small>}</span>}
  </span>;
}
export function CloudUsageDetails({ usage }: { usage?: Usage }) {
  if (!usage?.limits.length) return null;
  return <div className="cloudUsageDetails">{usage.limits.map(limit => <div className={`cloudQuota is-${tone(limit.usedPercent, limit.severity)}`} key={limit.id}>
    <div className="cloudQuotaHeading"><strong>{limit.label}</strong><span>{Math.round(limit.usedPercent)}% used</span></div>
    <div className="cloudQuotaTrack" role="meter" aria-label={`${limit.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={limit.usedPercent}><span style={{ width: `${limit.usedPercent}%` }}/></div>
    {limit.resetsAt && <small>Resets {new Date(limit.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>}
  </div>)}</div>;
}
export function CloudUsageIndicator({ workspace, usage }: { workspace: CloudWorkspace | null; usage?: Usage }) {
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId(); const [open, setOpen] = useState(false);
  const contextKnown = !!workspace?.contextWindow && typeof workspace.inputTokens === "number";
  const percent = contextKnown ? Math.min(100, workspace!.inputTokens! / workspace!.contextWindow! * 100) : undefined;
  const headline = usage?.limits.find(limit => limit.active) || usage?.limits.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b, usage.limits[0]);
  const used = headline ? Math.round(headline.usedPercent) : undefined;
  if (!contextKnown && used === undefined) return null;
  return <>
    <button ref={trigger} type="button" className="cloudUsageTrigger" aria-label={`Context and usage${used === undefined ? "" : `, ${used}% of the usage limit used`}${percent === undefined ? "" : `, ${Math.round(percent)}% context used`}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id} popoverTargetAction="toggle">{used !== undefined && <span className="cloudMiniUsage"><UsageRing compact value={used} used={headline?.usedPercent} severity={headline?.severity}/><span>{used === undefined ? "—" : `${used}%`}<small>{headline?.label || "Usage"}</small></span></span>}
      {contextKnown && <span className="cloudMiniUsage"><UsageRing compact value={percent} used={percent}/><span>{percent === undefined ? "—" : `${Math.round(percent)}%`}<small>Context</small></span></span>}</button>
    <div id={id} ref={popover} popover="auto" role="dialog" aria-label="Context and usage" className="cloudUsagePopover"
      onBeforeToggle={event => { if (event.newState !== "open" || !trigger.current) return; const rect = trigger.current.getBoundingClientRect();
        event.currentTarget.style.left = `${Math.max(12, Math.min(rect.right - 280, window.innerWidth - 292))}px`;
        event.currentTarget.style.bottom = `${window.innerHeight - rect.top + 8}px`; }}
      onToggle={event => setOpen(event.newState === "open")}>
      {contextKnown && <div className="cloudContextUsage cloudUsageWindow"><UsageRing value={percent} used={percent}/><div><strong>Context used</strong><span>{contextKnown ? `${workspace!.inputTokens!.toLocaleString()} / ${workspace!.contextWindow!.toLocaleString()}` : "Available after your first turn"}</span></div></div>}
      <CloudUsageDetails usage={usage}/>
    </div>
  </>;
}
