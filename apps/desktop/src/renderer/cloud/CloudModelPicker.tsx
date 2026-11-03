import React from "react";
import { CloudSelect } from "./CloudSelect";
import { CloudModelMenu } from "./CloudModelMenu";
import { cloudEffortLabels, type CloudEffort, type CloudModel, type CloudModelChoice } from "../../shared/cloud";

import { choiceForCloudModel, cloudModelDisplayName } from "./cloudModelChoices";

export function CloudModelPicker({ label, value, models, disabled, compact, onChange }: {
  label: string; value: CloudModelChoice; models: CloudModel[]; disabled?: boolean; compact?: boolean; onChange(value: CloudModelChoice): void;
}) {
  const selected = models.find(model => model.id === value.model);
  const efforts = selected?.efforts || [];
  if (compact) return <CloudModelMenu value={value} models={models} disabled={disabled} onChange={onChange}/>;
  return <div className="cloudModelPicker">
    <label><span>{label}</span><CloudSelect label={label === "Model" ? "Model" : `${label} model`} value={value.model} disabled={disabled || !models.length} onValueChange={selectedValue => {
      const model = models.find(item => item.id === selectedValue);
      if (!model) return;
      onChange(choiceForCloudModel(value, model));
    }}>
      {!selected && <option value={value.model} disabled>{cloudModelDisplayName(value.model)}{models.length ? " · unavailable" : ""}</option>}
      {models.map(model => <option key={model.id} value={model.id} disabled={!!model.unavailableReason}>{model.label === model.id ? cloudModelDisplayName(model.id) : model.label}{model.unavailableReason ? " · separate billing" : ""}</option>)}
    </CloudSelect></label>
    <label><span>Effort</span><CloudSelect label={label === "Model" ? "Reasoning effort" : `${label} effort`} value={efforts.length ? value.effort : "default"} disabled={disabled || !efforts.length}
      onValueChange={selectedValue => onChange({ ...value, effort: selectedValue as CloudEffort })}>
      {!efforts.length ? <option value="default">Default</option> : <>
        {!efforts.includes(value.effort) && <option value={value.effort} disabled>{cloudEffortLabels[value.effort]} · unavailable</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{cloudEffortLabels[effort]}</option>)}
      </>}
    </CloudSelect></label>
  </div>;
}
