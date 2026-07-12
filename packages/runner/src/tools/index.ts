import { isRunnerToolName, type RunnerToolName } from "../config.js";
import type { UmbraticRunnerEvent } from "../events.js";
import { toolDefinitions } from "./definitions.js";
import { buildToolPlan, allModelToolSpecs } from "./planner.js";
import { legacyToolResult } from "./results.js";
import { normalizeModelToolSpec, schemaHasAdapterHostileShapes } from "./schema.js";
import { ToolExecutionError, type ToolContext, type ToolResult } from "./common.js";
import { canonicalToolNameString, toolNameFromProvider, type ToolCall, type ToolRuntimeContext } from "./types.js";

export { normalizeModelToolSpec, schemaHasAdapterHostileShapes } from "./schema.js";
export { ToolRegistry } from "./registry.js";
export { buildToolPlan } from "./planner.js";
export { ToolScheduler } from "./scheduler.js";
export type { ToolPlan } from "./plan.js";
export type { ToolCall, ToolDefinition, ToolExecutionResult, ToolInvocation, ToolName } from "./types.js";

export const toolSpecs = allModelToolSpecs();

export function enabledToolSpecs(enabledTools: readonly RunnerToolName[]) {
  const enabled = new Set(enabledTools);
  return toolSpecs.filter((spec) => enabled.has(spec.function.name as RunnerToolName));
}

export function enabledModelToolSpecs(
  enabledTools: readonly RunnerToolName[],
  options: { includeContextRetrieval?: boolean; includeSkillReader?: boolean } = {},
) {
  return buildToolPlan({ enabledTools, ...options }).modelSpecs;
}

export function canonicalToolName(name: string): string {
  const normalized = name.toLowerCase();
  return isRunnerToolName(normalized) || normalized === "read_skill" || normalized === "retrieve_context" ? normalized : name;
}

function runtimeContext(ctx: ToolContext): ToolRuntimeContext {
  return {
    ...ctx,
    signal: ctx.signal ?? new AbortController().signal,
  };
}

/** Compatibility wrapper. New agent-loop code dispatches through a per-turn ToolPlan registry. */
export async function runTool(
  ctx: ToolContext,
  emit: (event: UmbraticRunnerEvent) => void,
  toolCall: { id: string; name: string; arguments: unknown },
): Promise<ToolResult> {
  const canonical = canonicalToolName(toolCall.name);
  const plan = buildToolPlan({
    enabledTools: ctx.enabledTools,
    includeContextRetrieval: canonical === "retrieve_context" && !!ctx.contextStore,
    includeSkillReader: canonical === "read_skill",
  });
  const call: ToolCall = {
    id: toolCall.id,
    name: toolNameFromProvider(canonical),
    payload: { kind: "function", arguments: typeof toolCall.arguments === "string" || (!!toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)) ? toolCall.arguments as string | Record<string, unknown> : String(toolCall.arguments ?? "") },
    index: 0,
  };
  const result = await plan.registry.dispatch(runtimeContext(ctx), emit, call, { planFingerprint: plan.fingerprint });
  if (result.error && (result.status === "validation_error" || result.status === "permission_denied" || result.status === "policy_blocked" || result.status === "aborted")) {
    throw new ToolExecutionError(result.status, result.error.code, result.error.message);
  }
  return legacyToolResult(result);
}

export const registeredToolNames = toolDefinitions.map((definition) => canonicalToolNameString(definition.name));
