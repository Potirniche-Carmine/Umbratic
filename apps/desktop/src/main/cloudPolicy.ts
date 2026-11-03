import type { CloudConnection, CloudProvider, CloudRole, CloudSettings } from "../shared/cloud";
import { cloudRoleLabels, modelChoiceError } from "../shared/cloud";

export function cloudEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  // The native runtime owns OAuth. Never supply API credentials or alternate
  // inference backends inherited from the process that launched Electron.
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|AZURE_OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|OTEL_)/i.test(key)) delete env[key];
  }
  delete env.CLAUDECODE;
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", OTEL_SDK_DISABLED: "true" };
}

export function enabledCloudRoles(settings: CloudSettings): CloudRole[] {
  return settings.subagents ? ["routine", "architecture", "research"] : [];
}

export function validateCloudConnection(connection: CloudConnection, settings: CloudSettings): void {
  if (connection.state !== "ready") throw new Error(connection.message);
  const config = settings.providers[connection.provider];
  for (const choice of [config.orchestrator, ...enabledCloudRoles(settings).map(role => config.roles[role])]) {
    const error = modelChoiceError(choice, connection.models);
    if (error) throw new Error(error);
  }
}

export const roleInstructions: Record<CloudRole, string> = {
  routine: "Implement a bounded routine change. Inspect relevant code, preserve unrelated work, and verify the changed behavior.",
  architecture: "Resolve a difficult implementation or architecture question. State constraints, inspect existing contracts, and choose the smallest coherent change.",
  research: "Perform bounded research and extraction. Do not edit files. Return concise findings with primary sources or exact file references. Flag uncertainty.",
};

export function cloudWorkflowInstructions(settings: CloudSettings, provider: CloudProvider): string {
  const roles = enabledCloudRoles(settings);
  return [
    "You are working in Umbratic. Complete the user's task using this runtime's native tools and permissions.",
    "Follow repository instructions. Preserve unrelated changes. Keep progress updates concise. Test behavior proportionately; do not write tests that merely mirror implementation. Report what was actually verified.",
    "Keep context focused on the current outcome. Search before reading whole files, bound tool output, and reuse findings already in context. Return evidence and file references instead of copying large logs or documents. Keep the user's constraints and next steps clear when native compaction occurs.",
    "Use the existing context window and native compaction. Do not create persistent memories or save conversation summaries for future sessions unless the user explicitly asks.",
    roles.length ? "Delegate only bounded, independent work when the benefit exceeds the extra context and coordination cost. Do not delegate trivial tasks or duplicate ongoing work. Give each agent only the scope, relevant references, and expected output it needs; request concise findings rather than raw transcripts. Reuse an existing expert for follow-up work on the same assignment when supported. These are workflow preferences, subordinate to runtime and repository rules." : "Work directly. Do not spawn subagents.",
    ...roles.map(role => {
      const choice = settings.providers[provider].roles[role];
      return `${cloudRoleLabels[role]}: use ${provider === "claude" ? `the umbratic_${role} agent` : `a native subagent with model ${choice.model} and reasoning effort ${choice.effort}`}. ${roleInstructions[role]}`;
    }),
  ].join("\n");
}
