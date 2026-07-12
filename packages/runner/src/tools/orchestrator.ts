import { toolError } from "./common.js";
import type { ToolDefinition, ToolIntent, ToolInvocation } from "./types.js";

export class ToolOrchestrator {
  async execute<TArgs>(
    definition: ToolDefinition<TArgs>,
    invocation: ToolInvocation<TArgs>,
    intent: ToolIntent,
    lifecycle: { permissionResolved?: (outcome: "passed" | "blocked", summary?: string) => void } = {},
  ) {
    if (intent.denyReason) throw toolError("policy_blocked", "policy_blocked", intent.denyReason);
    if (invocation.signal.aborted) throw toolError("aborted", "aborted", "Tool call was aborted.");
    if (intent.risk === "read" || intent.risk === "internal") return definition.execute(invocation);

    const permissionKind = intent.risk === "command" ? "bash" : "edit";
    const decision = await invocation.context.askPermission({
      permissionKind,
      summary: intent.summary,
      autoAllow: invocation.context.permissionMode === "bypass" && !(intent.risky ?? false),
    });
    if (invocation.signal.aborted) {
      lifecycle.permissionResolved?.("blocked", "aborted while waiting for permission");
      throw toolError("aborted", "aborted", "Tool call was aborted while waiting for permission.");
    }
    if (decision !== "allow") {
      lifecycle.permissionResolved?.("blocked", "permission denied");
      throw toolError("permission_denied", "permission_denied", `${definition.label} denied.`);
    }
    lifecycle.permissionResolved?.("passed");

    const executionContext = { ...invocation.context, askPermission: async () => "allow" as const };
    return definition.execute({ ...invocation, context: executionContext });
  }
}
