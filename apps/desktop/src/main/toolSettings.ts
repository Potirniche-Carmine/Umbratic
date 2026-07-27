import type { RunnerToolId } from "./types";

export const runnerToolIds = ["read", "write", "edit", "search", "lsp", "command"] as const satisfies readonly RunnerToolId[];

export function defaultToolSettings(): Record<RunnerToolId, boolean> {
  return Object.fromEntries(runnerToolIds.map((id) => [id, true])) as Record<RunnerToolId, boolean>;
}

export function isRunnerToolId(value: unknown): value is RunnerToolId {
  return typeof value === "string" && (runnerToolIds as readonly string[]).includes(value);
}

export function enabledToolsFromSettings(settings: Partial<Record<RunnerToolId, boolean>>): RunnerToolId[] {
  const normalized = { ...defaultToolSettings(), ...settings };
  return runnerToolIds.filter((id) => normalized[id] === true);
}

export function toolSettingsFromEnabledTools(enabledTools: readonly RunnerToolId[]): Record<RunnerToolId, boolean> {
  const enabled = new Set(enabledTools);
  return Object.fromEntries(runnerToolIds.map((id) => [id, enabled.has(id)])) as Record<RunnerToolId, boolean>;
}

export function normalizeEnabledTools(value: unknown, fallback: readonly RunnerToolId[] = runnerToolIds): RunnerToolId[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<RunnerToolId>();
  for (const item of value) {
    if (isRunnerToolId(item)) seen.add(item);
  }
  return runnerToolIds.filter((id) => seen.has(id));
}
