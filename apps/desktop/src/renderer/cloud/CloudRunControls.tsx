import React from "react";
import { Gauge, ShieldCheck, ShieldOff, Sparkles, Zap } from "lucide-react";
import type { CloudConnection, CloudSettings, CloudApprovalMode } from "../../shared/cloud";
import { CloudSelect } from "./CloudSelect";

export function CloudRunControls({ settings, connection, disabled, onSave }: { settings: CloudSettings; connection: CloudConnection | null; disabled: boolean; onSave(value: CloudSettings): void }) {
  const provider = settings.provider;
  const config = settings.providers[provider];
  const model = connection?.models.find(model => model.id === config.orchestrator.model);
  const choices = provider === "codex"
    ? [["manual", "Ask first"], ["auto", "Approve for me"]]
    : [["manual", "Ask first"], ["auto", "Auto approve"], ["bypass", "Bypass approvals"]];
  const tiers = model?.serviceTiers?.filter(tier => tier.id !== "default") || [];
  return <div className="cloudRunControls"><CloudSelect label="Approvals" icons={{ manual: <ShieldCheck size={14} aria-hidden="true"/>, auto: <Sparkles size={14} aria-hidden="true"/>, bypass: <ShieldOff size={14} aria-hidden="true"/> }} value={config.approvalMode || "manual"} disabled={disabled} onValueChange={value => onSave({ ...settings, providers: { ...settings.providers, [provider]: { ...config, approvalMode: value as CloudApprovalMode } } })}>
    {choices.map(([value, label]) => <option key={value} value={value} disabled={provider === "claude" && value === "auto" && model?.supportsAuto === false}>{label}</option>)}
  </CloudSelect>{provider === "codex" && tiers.length > 0 && <><CloudSelect icons={Object.fromEntries(["default", ...tiers.map(tier => tier.id)].map(value => [value, value === "default" ? <Gauge key={value} size={14}/> : <Zap key={value} size={14}/>]))} label="Speed" value={config.serviceTier || "default"} disabled={disabled} onValueChange={serviceTier => onSave({ ...settings, providers: { ...settings.providers, codex: { ...config, serviceTier } } })}><option value="default">Standard</option>{tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</CloudSelect></>}</div>;
}
