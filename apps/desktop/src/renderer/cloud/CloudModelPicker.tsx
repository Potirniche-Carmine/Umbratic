import React from "react";
import { CloudSelect } from "./CloudSelect";
import { cloudEffortLabels, type CloudEffort, type CloudModel, type CloudModelChoice } from "../../shared/cloud";

const presetNames: Record<string, string> = { "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6.1-terra": "GPT-6.1 Terra", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5" };
const displayName = (id: string) => presetNames[id] || id;

export function CloudModelPicker({ label, value, models, disabled, onChange }: {
  label: string; value: CloudModelChoice; models: CloudModel[]; disabled?: boolean; onChange(value: CloudModelChoice): void;
}) {
  const selected = models.find(model => model.id === value.model);
  const efforts = selected?.efforts || [];
  return <div className="cloudModelPicker">
    <label><span>{label}</span><CloudSelect label={`${label} model`} value={value.model} disabled={disabled || !models.length} onValueChange={selectedValue => {
      const model = models.find(item => item.id === selectedValue);
      if (!model) return;
      onChange({ model: model.id, effort: model.efforts.includes(value.effort) ? value.effort : model.defaultEffort || model.efforts[0] || "medium" });
    }}>
      {!selected && <option value={value.model} disabled>{displayName(value.model)}{models.length ? " · unavailable" : ""}</option>}
      {models.map(model => <option key={model.id} value={model.id} disabled={!!model.unavailableReason}>{model.label === model.id ? displayName(model.id) : model.label}{model.unavailableReason ? " · separate billing" : ""}</option>)}
    </CloudSelect></label>
    <label><span>Effort</span><CloudSelect label={`${label} effort`} value={efforts.length ? value.effort : "default"} disabled={disabled || !efforts.length}
      onValueChange={selectedValue => onChange({ ...value, effort: selectedValue as CloudEffort })}>
      {!efforts.length ? <option value="default">Default</option> : <>
        {!efforts.includes(value.effort) && <option value={value.effort} disabled>{cloudEffortLabels[value.effort]} · unavailable</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{cloudEffortLabels[effort]}</option>)}
      </>}
    </CloudSelect></label>
  </div>;
}
