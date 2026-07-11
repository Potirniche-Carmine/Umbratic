import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field}.`);
  }
  return value.trim();
}

export function quoteCommandArg(arg: string): string {
  return /\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function commandText(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandArg).join(" ");
}

export function pathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const lexicalRelative = path.relative(resolvedParent, resolvedChild);
  if (!(lexicalRelative === "" || (!!lexicalRelative && !lexicalRelative.startsWith("..") && !path.isAbsolute(lexicalRelative)))) return false;
  if (!fs.existsSync(resolvedParent)) return true;
  let existingChild = resolvedChild;
  while (!fs.existsSync(existingChild) && path.dirname(existingChild) !== existingChild) existingChild = path.dirname(existingChild);
  const relative = path.relative(fs.realpathSync.native(resolvedParent), fs.realpathSync.native(existingChild));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "change";
}

export function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}
