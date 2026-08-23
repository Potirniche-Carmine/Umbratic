/**
 * Field checks for payloads that arrive as `unknown` — IPC arguments, stored
 * JSON, and event streams. One definition, because a dozen private copies of
 * `isRecord` is how two of them drift apart.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

export function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

export function hasNonNegativeNumber(value: Record<string, unknown>, key: string): boolean {
  return hasNumber(value, key) && Number(value[key]) >= 0;
}

export function hasStringArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]) && (value[key] as unknown[]).every((item) => typeof item === "string");
}
