import type { ModelToolSpec } from "./types.js";
import type { ToolRegistry } from "./registry.js";

export type ToolPlan = Readonly<{
  modelSpecs: readonly ModelToolSpec[];
  registry: ToolRegistry;
  parallelToolCalls: boolean;
  fingerprint: string;
}>;
