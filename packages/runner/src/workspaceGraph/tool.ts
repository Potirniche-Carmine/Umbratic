import { toolError } from "../tools/common.js";
import type { WorkspaceGraphArgs } from "./types.js";

function inputRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw toolError("validation_error", "invalid_arguments", "workspace_graph arguments must be an object");
  return raw as Record<string, unknown>;
}

function allowedKeys(input: Record<string, unknown>, allowed: readonly string[]) {
  const invalid = Object.keys(input).filter((key) => !allowed.includes(key));
  if (invalid.length) throw toolError("validation_error", "invalid_arguments", `workspace_graph does not accept: ${invalid.join(", ")}`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw toolError("validation_error", "invalid_arguments", `workspace_graph requires ${key}`);
  return (input[key] as string).trim();
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw toolError("validation_error", "invalid_arguments", `workspace_graph ${key} must be a number`);
  return value;
}

function optionalStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw toolError("validation_error", "invalid_arguments", `workspace_graph ${key} must be an array of strings`);
  return value.map((item) => item.trim());
}

export function validateWorkspaceGraphArgs(raw: unknown): WorkspaceGraphArgs {
  const input = inputRecord(raw);
  const action = requiredString(input, "action");
  if (action === "summary") { allowedKeys(input, ["action"]); return { action }; }
  if (action === "query") { allowedKeys(input, ["action", "query", "depth", "limit"]); return { action, query: requiredString(input, "query"), depth: optionalNumber(input, "depth"), limit: optionalNumber(input, "limit") }; }
  if (action === "explain") { allowedKeys(input, ["action", "symbol", "limit"]); return { action, symbol: requiredString(input, "symbol"), limit: optionalNumber(input, "limit") }; }
  if (action === "path") { allowedKeys(input, ["action", "from", "to", "maxDepth"]); return { action, from: requiredString(input, "from"), to: requiredString(input, "to"), maxDepth: optionalNumber(input, "maxDepth") }; }
  if (action === "affected") {
    allowedKeys(input, ["action", "files", "symbols", "depth", "direction"]);
    const files = optionalStrings(input, "files");
    const symbols = optionalStrings(input, "symbols");
    if (!files?.length && !symbols?.length) throw toolError("validation_error", "invalid_arguments", "workspace_graph affected requires files or symbols");
    const direction = input.direction;
    if (direction !== undefined && direction !== "incoming" && direction !== "outgoing" && direction !== "both") throw toolError("validation_error", "invalid_arguments", "workspace_graph direction is invalid");
    return { action, files, symbols, depth: optionalNumber(input, "depth"), direction };
  }
  throw toolError("validation_error", "invalid_arguments", `workspace_graph action is unsupported: ${action}`);
}
