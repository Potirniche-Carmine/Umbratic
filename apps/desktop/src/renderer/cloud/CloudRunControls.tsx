import React from "react";
import { Hand, Sparkles, ShieldOff, Gauge, Zap } from "lucide-react";
import type { CloudConnection, CloudSettings, CloudApprovalMode } from "../../shared/cloud";
import { CloudSelect } from "./CloudSelect";

export function CloudRunControls({ settings, connection, disabled, onSave }: { settings: CloudSettings; connection: CloudConnection | null; disabled: boolean; onSave(value: CloudSettings): void }) {
  const provider = settings.provider;
  const config = settings.providers[provider];
  const model = connection?.models.find(model => model.id === config.orchestrator.model);
  const choices = [["manual", "Manual"], ["auto", "Auto"], [provider === "codex" ? "full-access" : "bypass", "Bypass"]];
  const icons = { manual: <Hand size={14}/>, auto: <Sparkles size={14}/>, "full-access": <ShieldOff size={14}/>, bypass: <ShieldOff size={14}/> };
  const tiers = model?.serviceTiers?.filter(tier => tier.id !== "default") || [];
  return <div className="cloudRunControls"><CloudSelect icons={icons} label="Approvals" value={config.approvalMode || "manual"} disabled={disabled} onValueChange={value => onSave({ ...settings, providers: { ...settings.providers, [provider]: { ...config, approvalMode: value as CloudApprovalMode } } })}>
    {choices.map(([value, label]) => <option key={value} value={value} disabled={provider === "claude" && value === "auto" && model?.supportsAuto === false}>{label}</option>)}
  </CloudSelect>{provider === "codex" && tiers.length > 0 && <><CloudSelect icons={Object.fromEntries(["default", ...tiers.map(tier => tier.id)].map(value => [value, value === "default" ? <Gauge key={value} size={14}/> : <Zap key={value} size={14}/>]))} label="Speed" value={config.serviceTier || "default"} disabled={disabled} onValueChange={serviceTier => onSave({ ...settings, providers: { ...settings.providers, codex: { ...config, serviceTier } } })}><option value="default">Standard</option>{tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</CloudSelect></>}</div>;
}
