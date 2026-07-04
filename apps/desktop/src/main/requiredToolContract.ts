import type { RunnerToolId } from "./types";

export type RequiredToolContractRequirement = "file_change";

export type RequiredToolContractReason =
  | "file_tools_disabled"
  | "missing_tool_call"
  | "agent_reported_blocker"
  | "attempted_tool_failed"
  | "no_review_changes";

export type RequiredToolFailureSummary = {
  reason: RequiredToolContractReason;
  detail: string;
};

export const requiredFileChangeTools: RunnerToolId[] = ["write", "edit", "command"];

const mutatingPromptPattern =
  /\b(add|build|change|create|delete|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|replace|scaffold|update|write)\b/i;
const codeTargetPattern =
  /\b(file|code|component|function|class|module|page|screen|route|api|test|bug|readme|docs?|scripts?|scrip|python|style|css|html|tsx?|jsx?|py|json|yaml|yml|toml|md)\b/i;

export function promptLooksLikeFileChange(prompt: string): boolean {
  const text = prompt.split(/\n\s*\nAttached files:/i)[0].trim();
  if (!text) return false;
  return mutatingPromptPattern.test(text) && codeTargetPattern.test(text);
}

export function enabledFileChangeTools(enabledTools: RunnerToolId[]): RunnerToolId[] {
  const enabled = new Set(enabledTools);
  return requiredFileChangeTools.filter((tool) => enabled.has(tool));
}

export function canSatisfyFileChangeContract(enabledTools: RunnerToolId[]): boolean {
  return enabledFileChangeTools(enabledTools).length > 0;
}

export function isFileChangingTool(toolKind: string): toolKind is RunnerToolId {
  return toolKind === "write" || toolKind === "edit" || toolKind === "command";
}

export function buildRequiredFileChangeRetryPrompt(input: {
  originalUserRequest?: string;
  previousAssistantText: string;
  enabledTools: RunnerToolId[];
  workspacePath?: string;
}): string {
  const originalUserRequest = input.originalUserRequest?.trim();
  const previousAssistantText = input.previousAssistantText.trim();
  const workspacePath = input.workspacePath?.trim();
  return [
    "Harness check failed: the user asked for file changes, but your previous turn ended without any file-changing tool call. Continue the original request; do not treat this retry prompt as a new standalone task.",
    originalUserRequest ? `Original user request:\n${originalUserRequest}` : "Original user request was unavailable; use the prior conversation and any attached context.",
    workspacePath ? `Workspace target directory: ${workspacePath}` : "",
    previousAssistantText ? `Your previous answer was:\n${previousAssistantText}` : "Your previous answer did not include a usable explanation.",
    `Enabled tools for this run: ${input.enabledTools.join(", ") || "none"}.`,
    "Choose exactly one path now:",
    "1. Create or modify the requested file by calling `write`, `edit`, or an approved workspace `command`, then reply briefly with the changed file path. If your previous answer already contains the requested document, save that content into an appropriate file in the workspace.",
    "2. Only if the original request is impossible to satisfy with the enabled tools, reply with exactly `CANNOT_CREATE_FILE:` followed by the specific blocker. Do not claim the file was created.",
  ].filter(Boolean).join("\n\n");
}

export function cannotCreateFileBlocker(assistantText: string): string | null {
  const trimmed = assistantText.trim();
  const match = trimmed.match(/^CANNOT[_\s-]?CREATE[_\s-]?FILE\s*:\s*(.*)$/i);
  if (!match) return null;
  return match[1].trim() || "The runner reported it could not create or modify files.";
}

export function noReviewFailureSummary(input: {
  toolRequested: boolean;
  toolSucceeded: boolean;
}): RequiredToolFailureSummary {
  if (!input.toolRequested) {
    return {
      reason: "missing_tool_call",
      detail: "No file creation tool was called.",
    };
  }
  if (!input.toolSucceeded) {
    return {
      reason: "attempted_tool_failed",
      detail: "A file creation tool was attempted but did not succeed.",
    };
  }
  return {
    reason: "no_review_changes",
    detail: "A file creation tool reported success, but no reviewable file changes were found.",
  };
}

export function requiredToolFailureMessage(summary: RequiredToolFailureSummary): string {
  return `Umbratic runner finished without file changes. ${summary.detail}`;
}
