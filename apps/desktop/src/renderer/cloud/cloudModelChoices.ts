import type { CloudModel, CloudModelChoice } from "../../shared/cloud";

const presetNames: Record<string, string> = { "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6.1-terra": "GPT-6.1 Terra", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5" };
export const cloudModelDisplayName = (id: string) => presetNames[id] || id;
export function choiceForCloudModel(current: CloudModelChoice, model: CloudModel): CloudModelChoice {
  return { model: model.id, effort: model.efforts.includes(current.effort) ? current.effort
    : model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0] || "medium" };
}
