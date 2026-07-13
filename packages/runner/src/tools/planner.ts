import * as crypto from "node:crypto";
import type { RunnerToolName } from "../config.js";
import { toolDefinitions } from "./definitions.js";
import { ToolRegistry } from "./registry.js";
import { normalizeModelToolSpec } from "./schema.js";
import { canonicalToolNameString, type ModelToolSpec, type ToolDefinition } from "./types.js";
import type { ToolPlan } from "./plan.js";

export type ToolPlanOptions = {
  enabledTools: readonly RunnerToolName[];
  includeContextRetrieval?: boolean;
  includeSkillReader?: boolean;
  providerParallelToolCalls?: boolean;
  includeWorkspaceGraph?: boolean;
};

function included(definition: ToolDefinition<any>, options: ToolPlanOptions): boolean {
  const name = canonicalToolNameString(definition.name);
  if (definition.exposure === "deferred") return false;
  if (name === "workspace_graph") return !!options.includeWorkspaceGraph && options.enabledTools.includes("workspace_graph");
  if (definition.exposure === "direct") return options.enabledTools.includes(name as RunnerToolName);
  if (name === "read_skill") return !!options.includeSkillReader;
  if (name === "retrieve_context") return !!options.includeContextRetrieval;
  return false;
}

function spec(definition: ToolDefinition<any>): ModelToolSpec {
  return normalizeModelToolSpec({
    type: "function",
    function: { name: canonicalToolNameString(definition.name), description: definition.description, parameters: definition.parameters },
  });
}

export function buildToolPlan(options: ToolPlanOptions): ToolPlan {
  const selected = toolDefinitions.filter((definition) => included(definition, options));
  const modelSpecs = selected.map(spec);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(modelSpecs)).digest("hex").slice(0, 16);
  const knownNames = new Set(toolDefinitions.map((definition) => canonicalToolNameString(definition.name).toLowerCase()));
  return Object.freeze({
    modelSpecs: Object.freeze(modelSpecs),
    registry: new ToolRegistry(selected, { knownNames, knownDefinitions: toolDefinitions }),
    parallelToolCalls: !!options.providerParallelToolCalls && selected.some((definition) => definition.executionMode === "parallel"),
    fingerprint,
  });
}

export function allModelToolSpecs(): ModelToolSpec[] {
  return toolDefinitions.filter((definition) => definition.exposure === "direct").map(spec);
}
