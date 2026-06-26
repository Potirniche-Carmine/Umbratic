import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readSkillSettings, writeSkillSettings } from "./storage";
import { pathInside } from "./utils";

export type SkillInfo = { id: string; name: string; description: string; enabled: boolean };
export type SkillDocument = SkillInfo & { path: string; content: string };
export type PromptSkillInfo = {
  id: string;
  name: string;
  description: string;
  instructionPath: string;
  content: string;
};

const skillFileByteLimit = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readTextFileIfSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > skillFileByteLimit) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export function skillDescriptionFromMarkdown(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
  const paragraph = withoutFrontmatter
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  return paragraph?.slice(0, 240) ?? "";
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^['"]|['"]$/g, "");
    if (kv[1] === "name") out.name = value;
    if (kv[1] === "description") out.description = value;
  }
  return out;
}

export function skillsDirectoryPath(): string {
  return path.join(os.homedir(), ".umbratic", "skills");
}

export function isValidSkillId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,96}$/.test(value);
}

export async function skillFilePathForId(id: string, directory = skillsDirectoryPath()): Promise<string | null> {
  if (!isValidSkillId(id)) return null;
  const root = path.resolve(directory);
  const candidates = [path.join(root, id, "SKILL.md"), path.join(root, `${id}.md`)];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!pathInside(root, resolved)) continue;
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export function skillInfoFromContent(id: string, content: string, settings: Record<string, boolean>): SkillInfo {
  const meta = parseSkillFrontmatter(content);
  return {
    id,
    name: meta.name || id,
    description: meta.description || skillDescriptionFromMarkdown(content),
    enabled: settings[id] !== false,
  };
}

export function readPromptSkillInfo(id: string, nameFallback: string, skillFile: string): PromptSkillInfo | null {
  const content = readTextFileIfSafe(skillFile) ?? "";
  if (!content.trim()) return null;
  const meta = parseSkillFrontmatter(content);
  return {
    id,
    name: meta.name || nameFallback,
    description: meta.description || skillDescriptionFromMarkdown(content),
    instructionPath: skillFile,
    content,
  };
}

export function collectPromptSkillsFromDirectory(directory: string): PromptSkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: PromptSkillInfo[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const skillFile = path.join(directory, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        const skill = readPromptSkillInfo(entry.name, entry.name, skillFile);
        if (skill) skills.push(skill);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = entry.name.replace(/\.md$/i, "");
      const skill = readPromptSkillInfo(id, id, path.join(directory, entry.name));
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export function requestedSkillIdsFromPrompt(userPrompt: string): Set<string> {
  const requested = new Set<string>();
  const pattern = /(^|[\s([{])\$([A-Za-z0-9_-]{1,96})\b/g;
  for (const match of userPrompt.matchAll(pattern)) {
    requested.add(match[2]);
  }
  return requested;
}

export function promptSkillsForRequest(
  userPrompt: string,
  directory = skillsDirectoryPath(),
  settings = readSkillSettings(),
): Array<PromptSkillInfo & { enabled: boolean; requested: boolean }> {
  const requestedIds = requestedSkillIdsFromPrompt(userPrompt);
  return collectPromptSkillsFromDirectory(directory)
    .map((skill) => ({
      ...skill,
      enabled: settings[skill.id] !== false,
      requested: requestedIds.has(skill.id),
    }))
    .filter((skill) => skill.enabled || skill.requested)
    .sort((left, right) => Number(right.requested) - Number(left.requested) || left.name.localeCompare(right.name))
    .slice(0, 24);
}

export async function listSkills(
  directory = skillsDirectoryPath(),
  settings = readSkillSettings(),
): Promise<{ skills: SkillInfo[]; directory: string }> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return { skills: [], directory };
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      const skillFile = path.join(directory, entry.name, "SKILL.md");
      let name = entry.name;
      let description = "";
      try {
        const content = await fs.promises.readFile(skillFile, "utf8");
        const info = skillInfoFromContent(entry.name, content, settings);
        name = info.name;
        description = info.description;
      } catch {
        // SKILL.md missing or unreadable: keep the visible folder name.
      }
      skills.push({ id: entry.name, name, description, enabled: settings[entry.name] !== false });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = entry.name.replace(/\.md$/i, "");
      let name = id;
      let description = "";
      try {
        const content = await fs.promises.readFile(path.join(directory, entry.name), "utf8");
        const info = skillInfoFromContent(id, content, settings);
        name = info.name;
        description = info.description;
      } catch {
        // Unreadable files remain listed by their file id.
      }
      skills.push({ id, name, description, enabled: settings[id] !== false });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, directory };
}

export async function getSkillDocument(
  input: { id?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillDocument; directory: string } | { ok: false; message: string }> {
  const id = (input?.id ?? "").trim();
  if (!isValidSkillId(id)) return { ok: false, message: "Invalid skill id." };
  const skillPath = await skillFilePathForId(id, directory);
  if (!skillPath) return { ok: false, message: "Skill file was not found." };
  try {
    const content = await fs.promises.readFile(skillPath, "utf8");
    const info = skillInfoFromContent(id, content, readSkillSettings());
    return { ok: true, directory, skill: { ...info, path: skillPath, content } };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function saveSkillDocument(
  input: { id?: string; content?: string },
  directory = skillsDirectoryPath(),
): Promise<
  | { ok: true; skill: SkillDocument; skills: SkillInfo[]; directory: string }
  | { ok: false; message: string }
> {
  const id = (input?.id ?? "").trim();
  if (!isValidSkillId(id)) return { ok: false, message: "Invalid skill id." };
  if (typeof input?.content !== "string") return { ok: false, message: "Skill content must be text." };
  if (Buffer.byteLength(input.content, "utf8") > skillFileByteLimit) {
    return { ok: false, message: "Skill file is too large to save." };
  }
  const skillPath = await skillFilePathForId(id, directory);
  if (!skillPath) return { ok: false, message: "Skill file was not found." };
  try {
    await fs.promises.writeFile(skillPath, input.content, "utf8");
    const info = skillInfoFromContent(id, input.content, readSkillSettings());
    const listing = await listSkills(directory);
    return {
      ok: true,
      directory,
      skills: listing.skills,
      skill: { ...info, path: skillPath, content: input.content },
    };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function createSkill(
  input: { name?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillInfo; directory: string } | { ok: false; message: string }> {
  const rawName = (input?.name ?? "").trim();
  if (!rawName) return { ok: false, message: "Enter a name for the skill." };
  const id = rawName.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) return { ok: false, message: "Use letters, numbers, hyphens, or underscores in the name." };
  const root = path.resolve(directory);
  const skillDir = path.join(root, id);
  try {
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.mkdir(skillDir, { recursive: false });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, message: `A skill named "${id}" already exists.` };
    }
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  const template = `---\nname: ${rawName}\ndescription: Briefly describe when Umbratic AI should use this skill.\n---\n\n# ${rawName}\n\nReplace this with the guidance Umbratic AI should follow when this skill is relevant.\n`;
  await fs.promises.writeFile(path.join(skillDir, "SKILL.md"), template, "utf8");
  writeSkillSettings({ [id]: true });
  return {
    ok: true,
    skill: { id, name: rawName, description: "Briefly describe when Umbratic AI should use this skill.", enabled: true },
    directory: root,
  };
}

export async function saveSkillSettings(
  input: unknown,
  directory = skillsDirectoryPath(),
): Promise<{ skills: SkillInfo[]; directory: string }> {
  if (!isRecord(input)) throw new Error("Invalid skill settings.");
  writeSkillSettings(input as Record<string, boolean>);
  return listSkills(directory);
}
