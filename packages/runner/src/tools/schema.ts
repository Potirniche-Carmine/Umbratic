import { toolError } from "./common.js";
import type { JsonSchema, ModelToolSpec } from "./types.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (isPlainRecord(value)) return value;
  if (typeof value !== "string") throw toolError("validation_error", "invalid_arguments", "Tool arguments must be a JSON object.");
  const normalized = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    throw toolError("validation_error", "invalid_arguments", "Tool arguments must be valid JSON.");
  }
  if (!isPlainRecord(parsed)) throw toolError("validation_error", "invalid_arguments", "Tool arguments must decode to a JSON object.");
  return parsed;
}

export function validateObjectArguments(
  name: string,
  raw: unknown,
  options: { allowed: readonly string[]; requiredStrings?: readonly string[]; emptyStrings?: readonly string[]; numbers?: readonly string[] },
): Record<string, unknown> {
  const input = isPlainRecord(raw) ? raw : parseToolArguments(raw);
  const unknown = Object.keys(input).find((key) => !options.allowed.includes(key));
  if (unknown) throw toolError("validation_error", "invalid_arguments", `${name} does not accept argument ${unknown}`);
  for (const key of options.requiredStrings ?? []) {
    if (typeof input[key] !== "string" || (!(options.emptyStrings ?? []).includes(key) && !(input[key] as string).trim())) {
      throw toolError("validation_error", "invalid_arguments", `${name} requires string argument ${key}`);
    }
  }
  for (const key of options.numbers ?? []) {
    if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || (input[key] as number) < 0)) {
      throw toolError("validation_error", "invalid_arguments", `${name} argument ${key} must be a non-negative number`);
    }
  }
  return input;
}

function normalizeSchemaType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value;
  return value.find((entry) => typeof entry === "string" && entry !== "null") ?? value.find((entry) => typeof entry === "string");
}

export function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!isPlainRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "additionalProperties" && typeof raw === "boolean") continue;
    if (key === "required") {
      normalized.required = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
      continue;
    }
    if (key === "type") {
      const type = normalizeSchemaType(raw);
      if (typeof type === "string") normalized.type = type;
      continue;
    }
    normalized[key] = normalizeJsonSchema(raw);
  }
  if (normalized.type === undefined) {
    if (isPlainRecord(normalized.properties)) normalized.type = "object";
    else if (normalized.items !== undefined) normalized.type = "array";
    else if (Array.isArray(normalized.enum)) {
      const item = normalized.enum.find((entry) => entry !== null && entry !== undefined);
      if (typeof item === "string") normalized.type = "string";
      if (typeof item === "number") normalized.type = "number";
      if (typeof item === "boolean") normalized.type = "boolean";
    }
  }
  if (normalized.type === "object" && !Array.isArray(normalized.required)) normalized.required = [];
  return normalized;
}

export function normalizeModelToolSpec(spec: ModelToolSpec): ModelToolSpec {
  return {
    type: "function",
    function: {
      name: spec.function.name,
      ...(spec.function.description ? { description: spec.function.description } : {}),
      parameters: normalizeJsonSchema(spec.function.parameters) as JsonSchema,
    },
  };
}

export function schemaHasAdapterHostileShapes(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(schemaHasAdapterHostileShapes);
  if (!isPlainRecord(value)) return false;
  if (Array.isArray(value.type) || typeof value.additionalProperties === "boolean") return true;
  if ("oneOf" in value || "anyOf" in value || "allOf" in value) return true;
  if (isPlainRecord(value.properties) && typeof value.type !== "string") return true;
  return Object.values(value).some(schemaHasAdapterHostileShapes);
}
