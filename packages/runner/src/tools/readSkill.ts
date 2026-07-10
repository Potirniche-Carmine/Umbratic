import * as fs from "node:fs";
import * as path from "node:path";

import { isBlockedPath } from "../policy.js";
import { ensureReadableText, pathInside, toolError, type ToolContext, type ToolResult } from "./common.js";

const defaultChunkBytes = 6 * 1024;
const maxChunkBytes = 8 * 1024;

function byteArgument(value: unknown, fallback: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.max(0, Math.floor(value));
  return maximum === undefined ? normalized : Math.min(normalized, maximum);
}

function skillResourcePath(instructionPath: string, resource: string | undefined): string {
  const primary = path.resolve(instructionPath);
  if (!resource || resource === "SKILL.md") return primary;
  if (path.basename(primary).toLowerCase() !== "skill.md") {
    throw toolError("validation_error", "invalid_arguments", "This standalone skill has no readable resource folder.");
  }
  if (path.isAbsolute(resource)) {
    throw toolError("policy_blocked", "workspace_boundary", "Skill resources must use a relative path.");
  }
  const root = path.dirname(primary);
  const target = path.resolve(root, resource);
  if (!pathInside(root, target)) {
    throw toolError("policy_blocked", "workspace_boundary", "Refusing skill resource outside its skill folder.");
  }
  const relative = path.relative(root, target).replace(/\\/g, "/");
  if (isBlockedPath(relative)) {
    throw toolError("policy_blocked", "blocked_path", `Refusing blocked skill resource: ${relative}`);
  }
  return target;
}

function safeChunkEnd(buffer: Buffer, start: number, requestedEnd: number): number {
  let end = Math.min(buffer.length, Math.max(start, requestedEnd));
  if (end >= buffer.length) return end;
  while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end > start ? end : Math.min(buffer.length, requestedEnd);
}

export function readSkillTool(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const skillId = typeof input.skillId === "string" ? input.skillId.trim() : "";
  if (!skillId) throw toolError("validation_error", "invalid_arguments", "read_skill requires skillId");
  const skill = ctx.skills?.find((entry) => entry.id === skillId);
  if (!skill) throw toolError("validation_error", "invalid_arguments", `Skill ${skillId} is not enabled.`);
  const resource = typeof input.resource === "string" && input.resource.trim() ? input.resource.trim() : undefined;
  const target = skillResourcePath(skill.instructionPath, resource);
  if (!fs.existsSync(target)) {
    throw toolError("validation_error", "invalid_arguments", `Skill resource not found: ${resource ?? "SKILL.md"}`);
  }
  const content = ensureReadableText(target);
  const buffer = Buffer.from(content, "utf8");
  const offset = Math.min(byteArgument(input.offset, 0), buffer.length);
  const limit = Math.max(1, byteArgument(input.limit, defaultChunkBytes, maxChunkBytes));
  const end = safeChunkEnd(buffer, offset, offset + limit);
  const body = buffer.subarray(offset, end).toString("utf8");
  const label = resource ?? path.basename(skill.instructionPath);
  const lines = [
    `Skill: ${skill.id} (${skill.name})`,
    `Resource: ${label}`,
    `Bytes: ${offset}-${end} of ${buffer.length}`,
    end < buffer.length ? `Next offset: ${end}` : "Read status: complete",
    "",
    body,
  ];
  return {
    title: resource ? `${skill.id}/${resource}` : skill.id,
    output: lines.join("\n"),
    status: "success",
    exitCode: 0,
  };
}
