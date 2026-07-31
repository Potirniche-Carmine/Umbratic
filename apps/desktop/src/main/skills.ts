import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { app } from "electron";

import { skillsDirectory } from "./appPaths";
import { readSkillSettings, writeSkillSettings } from "./storage";
import type { HarnessProfileId } from "./types";
import { pathInside } from "./utils";

export type SkillSource = "system" | "local";
export type SkillChecksumStatus = "known_good" | "modified" | "untracked";
export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: SkillSource;
  readOnly: boolean;
  checksum?: string;
  checksumStatus: SkillChecksumStatus;
  modified: boolean;
  provenance?: "bundled" | "created" | "imported";
  paths?: string[];
};
export type SkillDocument = SkillInfo & { path: string; content: string };
export type PromptSkillInfo = {
  id: string;
  name: string;
  description: string;
  instructionPath: string;
  source: SkillSource;
  paths?: string[];
};

type SystemSkillDefinition = {
  id: string;
};

type SkillManifestEntry = {
  checksum: string;
  provenance: "created" | "imported";
  recordedAt: string;
};

type SkillManifest = {
  version: 1;
  skills: Record<string, SkillManifestEntry>;
};

const skillFileByteLimit = 512 * 1024;
const skillImportTotalByteLimit = 10 * 1024 * 1024;
const skillImportArchiveByteLimit = 10 * 1024 * 1024;
const skillImportMaxEntries = 256;
const skillImportMaxEntryBytes = 2 * 1024 * 1024;
const skillImportTempPrefix = "umbratic-skill-import-";
const skillManifestFileName = ".manifest.json";
const zipUnixSymlinkMode = 0o120000;

const systemSkillDefinitions: SystemSkillDefinition[] = [
  { id: "umbratic-skill-creator" },
  { id: "umbratic-git-worktree" },
  { id: "umbratic-markdown" },
  { id: "umbratic-python" },
  { id: "umbratic-pdf" },
  { id: "umbratic-data-analysis" },
  { id: "umbratic-presentations" },
  { id: "umbratic-documents" },
  { id: "umbratic-spreadsheets" },
];

const harnessSystemSkillIds: Record<HarnessProfileId, ReadonlySet<string>> = {
  engineering: new Set([
    "umbratic-skill-creator",
    "umbratic-git-worktree",
    "umbratic-markdown",
    "umbratic-python",
  ]),
  marketing: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
  sales: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
};

export function harnessSystemSkillSettings(profileId: HarnessProfileId): Record<string, boolean> {
  const enabled = harnessSystemSkillIds[profileId];
  return Object.fromEntries(systemSkillDefinitions.map((skill) => [skill.id, enabled.has(skill.id)]));
}

export function applyHarnessSystemSkillSettings(profileId: HarnessProfileId): Record<string, boolean> {
  return writeSkillSettings(harnessSystemSkillSettings(profileId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(buffer: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function manifestPath(directory: string): string {
  return path.join(path.resolve(directory), skillManifestFileName);
}

function readSkillManifest(directory: string): SkillManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(directory), "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) {
      return { version: 1, skills: {} };
    }
    const skills: Record<string, SkillManifestEntry> = {};
    for (const [id, value] of Object.entries(parsed.skills)) {
      if (
        isValidSkillId(id) &&
        isRecord(value) &&
        typeof value.checksum === "string" &&
        /^sha256:[a-f0-9]{64}$/i.test(value.checksum) &&
        (value.provenance === "created" || value.provenance === "imported") &&
        typeof value.recordedAt === "string"
      ) {
        skills[id] = {
          checksum: value.checksum.toLowerCase(),
          provenance: value.provenance,
          recordedAt: value.recordedAt,
        };
      }
    }
    return { version: 1, skills };
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeSkillManifest(directory: string, manifest: SkillManifest) {
  fs.mkdirSync(path.resolve(directory), { recursive: true });
  fs.writeFileSync(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function recordSkillChecksum(directory: string, id: string, checksum: string, provenance: "created" | "imported") {
  const manifest = readSkillManifest(directory);
  manifest.skills[id] = { checksum, provenance, recordedAt: new Date().toISOString() };
  writeSkillManifest(directory, manifest);
}

function checksumPath(targetPath: string): string | undefined {
  try {
    const resolved = path.resolve(targetPath);
    const stat = fs.statSync(resolved);
    const hash = crypto.createHash("sha256");
    let totalBytes = 0;
    const addFile = (filePath: string, rootPath: string) => {
      const fileStat = fs.statSync(filePath);
      if (!fileStat.isFile()) return;
      totalBytes += fileStat.size;
      if (totalBytes > skillImportTotalByteLimit) throw new Error("skill checksum input too large");
      const relative = path.relative(rootPath, filePath).replace(/\\/g, "/");
      hash.update(`file:${relative}\0`);
      hash.update(fs.readFileSync(filePath));
      hash.update("\0");
    };
    if (stat.isFile()) {
      addFile(resolved, path.dirname(resolved));
    } else if (stat.isDirectory()) {
      const walk = (directoryPath: string) => {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
          .filter((entry) => entry.name !== ".DS_Store")
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const entryPath = path.join(directoryPath, entry.name);
          if (entry.isDirectory()) walk(entryPath);
          else addFile(entryPath, resolved);
        }
      };
      walk(resolved);
    } else {
      return undefined;
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return undefined;
  }
}

function readTextFileIfSafe(filePath: string): string | null {
  return textFileIfSafe(filePath, skillFileByteLimit);
}

export function skillDescriptionFromMarkdown(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
  const paragraph = withoutFrontmatter
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  return paragraph?.slice(0, 240) ?? "";
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string; paths?: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: { name?: string; description?: string; paths?: string[] } = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^paths:\s*$/.test(line)) {
      const paths: string[] = [];
      while (index + 1 < lines.length) {
        const item = lines[index + 1].match(/^\s+-\s+(.+)$/);
        if (!item) break;
        paths.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
        index += 1;
      }
      if (paths.length > 0) out.paths = paths;
      continue;
    }
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^['"]|['"]$/g, "");
    if (kv[1] === "name") out.name = value;
    if (kv[1] === "description") out.description = value;
    if (kv[1] === "paths") {
      const paths = value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      if (paths.length > 0) out.paths = paths;
    }
  }
  return out;
}

export function skillsDirectoryPath(): string {
  return skillsDirectory(app.getPath("userData"));
}

export function isValidSkillId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,96}$/.test(value);
}

function skillIdFromName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function systemSkillsDirectory(directory = skillsDirectoryPath()): string {
  return path.join(directory, "system");
}

function systemSkillDirectory(skill: Pick<SystemSkillDefinition, "id">, directory = skillsDirectoryPath()): string {
  return path.join(systemSkillsDirectory(directory), skill.id);
}

function systemSkillFilePath(skill: Pick<SystemSkillDefinition, "id">, directory = skillsDirectoryPath()): string {
  return path.join(systemSkillDirectory(skill, directory), "SKILL.md");
}

function bundledSystemSkillDirectoryCandidates(): string[] {
  return [
    path.join(__dirname, "system-skills"),
    path.resolve(__dirname, "../../src/main/system-skills"),
    path.resolve(process.cwd(), "src/main/system-skills"),
    path.resolve(process.cwd(), "apps/desktop/src/main/system-skills"),
  ];
}

function bundledSystemSkillsDirectory(): string {
  for (const candidate of bundledSystemSkillDirectoryCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return bundledSystemSkillDirectoryCandidates()[0];
}

function bundledSystemSkillContent(id: string): string {
  const skillFile = path.join(bundledSystemSkillsDirectory(), id, "SKILL.md");
  const content = readTextFileIfSafe(skillFile);
  if (!content?.trim()) throw new Error(`System skill ${id} is missing or unreadable.`);
  return content;
}

function systemSkillById(id: string): SystemSkillDefinition | undefined {
  return systemSkillDefinitions.find((skill) => skill.id === id);
}

function isReservedSkillId(id: string): boolean {
  return id === "system" || systemSkillDefinitions.some((skill) => skill.id === id);
}

function ensureSystemSkillFiles(directory = skillsDirectoryPath()) {
  const root = path.resolve(directory);
  fs.mkdirSync(systemSkillsDirectory(root), { recursive: true });
  for (const skill of systemSkillDefinitions) {
    const skillDir = systemSkillDirectory(skill, root);
    const skillFile = systemSkillFilePath(skill, root);
    fs.mkdirSync(skillDir, { recursive: true });
    if (!fs.existsSync(skillFile)) {
      fs.writeFileSync(skillFile, bundledSystemSkillContent(skill.id), "utf8");
    }
  }
}

export function installBundledSystemSkills(directory = skillsDirectoryPath()): string {
  const root = path.resolve(directory);
  ensureSystemSkillFiles(root);
  return root;
}

function textFileIfSafe(filePath: string, byteLimit: number): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > byteLimit) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export async function skillFilePathForId(id: string, directory = skillsDirectoryPath()): Promise<string | null> {
  if (!isValidSkillId(id) || isReservedSkillId(id)) return null;
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

export function skillInfoFromContent(
  id: string,
  content: string,
  settings: Record<string, boolean>,
  governance?: { checksum?: string; manifest?: SkillManifestEntry },
): SkillInfo {
  const meta = parseSkillFrontmatter(content);
  const checksum = governance?.checksum ?? sha256Hex(content);
  const expected = governance?.manifest?.checksum;
  const modified = !!expected && checksum !== expected;
  return {
    id,
    name: meta.name || id,
    description: meta.description || skillDescriptionFromMarkdown(content),
    enabled: settings[id] !== false,
    source: "local",
    paths: meta.paths,
    readOnly: false,
    checksum,
    checksumStatus: expected ? modified ? "modified" : "known_good" : "untracked",
    modified,
    provenance: governance?.manifest?.provenance,
  };
}

function systemSkillContent(skill: SystemSkillDefinition, directory = skillsDirectoryPath()): string {
  ensureSystemSkillFiles(directory);
  return readTextFileIfSafe(systemSkillFilePath(skill, directory)) ?? bundledSystemSkillContent(skill.id);
}

function systemSkillDisplayInfo(skill: SystemSkillDefinition, settings: Record<string, boolean>, directory = skillsDirectoryPath()): SkillInfo {
  const content = systemSkillContent(skill, directory);
  const bundled = bundledSystemSkillContent(skill.id);
  const checksum = sha256Hex(content);
  const bundledChecksum = sha256Hex(bundled);
  const modified = checksum !== bundledChecksum;
  const meta = parseSkillFrontmatter(content);
  return {
    id: skill.id,
    name: meta.name || skill.id,
    description: meta.description || skillDescriptionFromMarkdown(content),
    enabled: settings[skill.id] !== false,
    source: "system",
    readOnly: false,
    checksum,
    checksumStatus: modified ? "modified" : "known_good",
    modified,
    provenance: "bundled",
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
    source: "local",
    paths: meta.paths,
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
    if (entry.name.startsWith(".") || isReservedSkillId(entry.name)) continue;
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
      if (isReservedSkillId(id)) continue;
      const skill = readPromptSkillInfo(id, id, path.join(directory, entry.name));
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export function enabledPromptSkills(
  directory = skillsDirectoryPath(),
  settings = readSkillSettings(),
): PromptSkillInfo[] {
  ensureSystemSkillFiles(directory);
  const systemSkills = systemSkillDefinitions
    .filter((skill) => settings[skill.id] !== false)
    .map((skill) => {
      const info = systemSkillDisplayInfo(skill, settings, directory);
      return {
        id: skill.id,
        name: info.name,
        description: info.description,
        instructionPath: systemSkillFilePath(skill, directory),
        source: "system" as const,
        paths: parseSkillFrontmatter(readTextFileIfSafe(systemSkillFilePath(skill, directory)) ?? "").paths,
      };
    });
  const localSkills = collectPromptSkillsFromDirectory(directory)
    .filter((skill) => settings[skill.id] !== false);
  return [...systemSkills, ...localSkills];
}

export async function listSkills(
  directory = skillsDirectoryPath(),
  settings = readSkillSettings(),
): Promise<{ skills: SkillInfo[]; directory: string }> {
  ensureSystemSkillFiles(directory);
  const manifest = readSkillManifest(directory);
  const skills: SkillInfo[] = systemSkillDefinitions.map((skill) => systemSkillDisplayInfo(skill, settings, directory));
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return { skills, directory };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || isReservedSkillId(entry.name)) continue;

    if (entry.isDirectory()) {
      const skillFile = path.join(directory, entry.name, "SKILL.md");
      const skillRoot = path.join(directory, entry.name);
      let name = entry.name;
      let description = "";
      let info: SkillInfo | undefined;
      try {
        const content = await fs.promises.readFile(skillFile, "utf8");
        info = skillInfoFromContent(entry.name, content, settings, {
          checksum: checksumPath(skillRoot),
          manifest: manifest.skills[entry.name],
        });
        name = info.name;
        description = info.description;
      } catch {
        // SKILL.md missing or unreadable: keep the visible folder name.
      }
      skills.push(info ?? {
        id: entry.name,
        name,
        description,
        enabled: settings[entry.name] !== false,
        source: "local",
        readOnly: false,
        checksum: checksumPath(skillRoot),
        checksumStatus: "untracked",
        modified: false,
      });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = entry.name.replace(/\.md$/i, "");
      if (isReservedSkillId(id)) continue;
      const skillFile = path.join(directory, entry.name);
      let name = id;
      let description = "";
      let info: SkillInfo | undefined;
      try {
        const content = await fs.promises.readFile(skillFile, "utf8");
        info = skillInfoFromContent(id, content, settings, {
          checksum: checksumPath(skillFile),
          manifest: manifest.skills[id],
        });
        name = info.name;
        description = info.description;
      } catch {
        // Unreadable files remain listed by their file id.
      }
      skills.push(info ?? {
        id,
        name,
        description,
        enabled: settings[id] !== false,
        source: "local",
        readOnly: false,
        checksum: checksumPath(skillFile),
        checksumStatus: "untracked",
        modified: false,
      });
    }
  }

  skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return { skills, directory };
}

export async function getSkillDocument(
  input: { id?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillDocument; directory: string } | { ok: false; message: string }> {
  const id = (input?.id ?? "").trim();
  if (!isValidSkillId(id)) return { ok: false, message: "Invalid skill id." };
  const systemSkill = systemSkillById(id);
  if (systemSkill) {
    ensureSystemSkillFiles(directory);
    const skillPath = systemSkillFilePath(systemSkill, directory);
    const content = await fs.promises.readFile(skillPath, "utf8");
    const info = systemSkillDisplayInfo(systemSkill, readSkillSettings(), directory);
    return { ok: true, directory, skill: { ...info, path: skillPath, content } };
  }
  const skillPath = await skillFilePathForId(id, directory);
  if (!skillPath) return { ok: false, message: "Skill file was not found." };
  try {
    const content = await fs.promises.readFile(skillPath, "utf8");
    const manifest = readSkillManifest(directory);
    const checksumTarget = path.basename(skillPath).toLowerCase() === "skill.md" ? path.dirname(skillPath) : skillPath;
    const info = skillInfoFromContent(id, content, readSkillSettings(), {
      checksum: checksumPath(checksumTarget),
      manifest: manifest.skills[id],
    });
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
  const systemSkill = systemSkillById(id);
  if (systemSkill) {
    try {
      ensureSystemSkillFiles(directory);
      const skillPath = systemSkillFilePath(systemSkill, directory);
      await fs.promises.writeFile(skillPath, input.content, "utf8");
      const info = systemSkillDisplayInfo(systemSkill, readSkillSettings(), directory);
      const listing = await listSkills(directory);
      return { ok: true, directory, skills: listing.skills, skill: { ...info, path: skillPath, content: input.content } };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  const skillPath = await skillFilePathForId(id, directory);
  if (!skillPath) return { ok: false, message: "Skill file was not found." };
  try {
    await fs.promises.writeFile(skillPath, input.content, "utf8");
    const manifest = readSkillManifest(directory);
    const checksumTarget = path.basename(skillPath).toLowerCase() === "skill.md" ? path.dirname(skillPath) : skillPath;
    const info = skillInfoFromContent(id, input.content, readSkillSettings(), {
      checksum: checksumPath(checksumTarget),
      manifest: manifest.skills[id],
    });
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

export async function resetSystemSkill(
  input: { id?: string },
  directory = skillsDirectoryPath(),
): Promise<
  | { ok: true; skill: SkillDocument; skills: SkillInfo[]; directory: string }
  | { ok: false; message: string }
> {
  const id = (input?.id ?? "").trim();
  if (!isValidSkillId(id)) return { ok: false, message: "Invalid skill id." };
  const systemSkill = systemSkillById(id);
  if (!systemSkill) return { ok: false, message: "Only system skills can be reset." };
  try {
    ensureSystemSkillFiles(directory);
    const skillPath = systemSkillFilePath(systemSkill, directory);
    const content = bundledSystemSkillContent(id);
    await fs.promises.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.promises.writeFile(skillPath, content, "utf8");
    const info = systemSkillDisplayInfo(systemSkill, readSkillSettings(), directory);
    const listing = await listSkills(directory);
    return { ok: true, directory, skills: listing.skills, skill: { ...info, path: skillPath, content } };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

function safeZipEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function extractZipToDirectory(zipFile: string, outputDir: string) {
  const archiveStat = fs.lstatSync(zipFile);
  if (archiveStat.isSymbolicLink()) throw new Error("Skill zip path must not be a symbolic link.");
  if (!archiveStat.isFile()) throw new Error("Skill zip path must be a regular file.");
  if (archiveStat.size > skillImportArchiveByteLimit) throw new Error("Skill import archive is too large.");
  const data = fs.readFileSync(zipFile);
  let eocd = -1;
  const min = Math.max(0, data.length - 0xffff - 22);
  for (let index = data.length - 22; index >= min; index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("Zip file is missing a central directory.");
  const entryCount = data.readUInt16LE(eocd + 10);
  if (entryCount > skillImportMaxEntries) throw new Error("Skill import has too many zip entries.");
  let centralOffset = data.readUInt32LE(eocd + 16);
  let totalBytes = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (data.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("Zip central directory is invalid.");
    const flags = data.readUInt16LE(centralOffset + 8);
    const method = data.readUInt16LE(centralOffset + 10);
    const compressedSize = data.readUInt32LE(centralOffset + 20);
    const uncompressedSize = data.readUInt32LE(centralOffset + 24);
    const nameLength = data.readUInt16LE(centralOffset + 28);
    const extraLength = data.readUInt16LE(centralOffset + 30);
    const commentLength = data.readUInt16LE(centralOffset + 32);
    const externalAttrs = data.readUInt32LE(centralOffset + 38);
    const localOffset = data.readUInt32LE(centralOffset + 42);
    const entryName = safeZipEntryName(data.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8"));
    centralOffset += 46 + nameLength + extraLength + commentLength;

    if (!entryName || entryName.endsWith("/")) continue;
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === zipUnixSymlinkMode) {
      throw new Error("Zip symlinks are not supported.");
    }
    if ((flags & 1) !== 0) throw new Error("Encrypted zip entries are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Zip64 skill imports are not supported.");
    }
    if (uncompressedSize > skillImportMaxEntryBytes) throw new Error("Skill import entry is too large.");
    if (totalBytes + uncompressedSize > skillImportTotalByteLimit) throw new Error("Skill import is too large.");
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Zip local file header is invalid.");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    if (contentStart + compressedSize > data.length) throw new Error("Zip entry content is truncated.");
    const compressed = data.subarray(contentStart, contentStart + compressedSize);
    const content = method === 0
      ? compressed
      : method === 8
        ? zlib.inflateRawSync(compressed, { maxOutputLength: uncompressedSize })
        : (() => { throw new Error(`Unsupported zip compression method ${method}.`); })();
    if (content.length !== uncompressedSize) {
      throw new Error("Zip entry size does not match the claimed uncompressed size.");
    }
    totalBytes += content.length;
    if (totalBytes > skillImportTotalByteLimit) throw new Error("Skill import is too large.");
    const destination = path.resolve(outputDir, entryName);
    if (!pathInside(outputDir, destination)) throw new Error("Zip entry escaped the import directory.");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

function importedSkillRoot(sourcePath: string): string | null {
  const resolved = path.resolve(sourcePath);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isFile() && path.basename(resolved).toLowerCase() === "skill.md") return path.dirname(resolved);
    if (stat.isFile() && resolved.toLowerCase().endsWith(".md")) return resolved;
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  if (fs.existsSync(path.join(resolved, "SKILL.md"))) return resolved;
  const entries = fs.readdirSync(resolved, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  const childSkillDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolved, entry.name))
    .filter((child) => fs.existsSync(path.join(child, "SKILL.md")));
  return childSkillDirs.length === 1 ? childSkillDirs[0] : null;
}

function copyDirectoryContents(sourceDir: string, targetDir: string) {
  let totalBytes = 0;
  const copyEntry = (source: string, target: string) => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("Skill import refuses symbolic links.");
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source)) {
        if (entry === ".DS_Store") continue;
        copyEntry(path.join(source, entry), path.join(target, entry));
      }
      return;
    }
    if (!stat.isFile()) return;
    totalBytes += stat.size;
    if (totalBytes > skillImportTotalByteLimit) throw new Error("Skill import is too large.");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  };
  copyEntry(sourceDir, targetDir);
}

function importedSkillId(sourcePath: string, skillContent: string): string {
  const meta = parseSkillFrontmatter(skillContent);
  return skillIdFromName(meta.name || path.basename(sourcePath).replace(/\.(zip|md)$/i, "")) || "imported-skill";
}

export async function importSkill(
  input: { sourcePath?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillInfo; skills: SkillInfo[]; directory: string } | { ok: false; message: string }> {
  const sourcePath = typeof input?.sourcePath === "string" ? path.resolve(input.sourcePath) : "";
  if (!sourcePath) return { ok: false, message: "Choose a skill folder, SKILL.md file, or .zip archive to import." };
  const root = path.resolve(directory);
  let tempDir: string | null = null;
  try {
    await fs.promises.mkdir(root, { recursive: true });
    let sourceRoot: string | null = null;
    const stat = fs.statSync(sourcePath);
    if (stat.isFile() && sourcePath.toLowerCase().endsWith(".zip")) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), skillImportTempPrefix));
      extractZipToDirectory(sourcePath, tempDir);
      sourceRoot = importedSkillRoot(tempDir);
    } else {
      sourceRoot = importedSkillRoot(sourcePath);
    }
    if (!sourceRoot) return { ok: false, message: "Imported skill must be a folder containing SKILL.md, a SKILL.md file, or a zip with one skill folder." };

    const skillFile = fs.statSync(sourceRoot).isFile() ? sourceRoot : path.join(sourceRoot, "SKILL.md");
    const content = readTextFileIfSafe(skillFile);
    if (!content?.trim()) return { ok: false, message: "Imported SKILL.md is empty, binary, or too large." };
    const id = importedSkillId(sourcePath, content);
    if (!isValidSkillId(id)) return { ok: false, message: "Imported skill name does not produce a valid skill id." };
    if (isReservedSkillId(id)) return { ok: false, message: `A reserved skill named "${id}" already exists.` };
    const target = path.join(root, id);
    if (!pathInside(root, target)) return { ok: false, message: "Imported skill path is invalid." };
    if (fs.existsSync(target) || fs.existsSync(`${target}.md`)) return { ok: false, message: `A skill named "${id}" already exists.` };

    if (fs.statSync(sourceRoot).isFile()) {
      await fs.promises.mkdir(target, { recursive: false });
      await fs.promises.copyFile(sourceRoot, path.join(target, "SKILL.md"));
    } else {
      await fs.promises.mkdir(target, { recursive: false });
      copyDirectoryContents(sourceRoot, target);
    }
    recordSkillChecksum(root, id, checksumPath(target) ?? sha256Hex(content), "imported");
    writeSkillSettings({ [id]: true });
    const listing = await listSkills(directory);
    const skill = listing.skills.find((row) => row.id === id);
    if (!skill) return { ok: false, message: "Skill imported but could not be listed." };
    return { ok: true, skill, skills: listing.skills, directory: root };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function createSkill(
  input: { name?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillInfo; directory: string } | { ok: false; message: string }> {
  const rawName = (input?.name ?? "").trim();
  if (!rawName) return { ok: false, message: "Enter a name for the skill." };
  const id = skillIdFromName(rawName);
  if (!id) return { ok: false, message: "Use letters, numbers, hyphens, or underscores in the name." };
  if (isReservedSkillId(id)) return { ok: false, message: `A reserved skill named "${id}" already exists.` };
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
  const template = `---\nname: ${rawName}\ndescription: Briefly describe when Umbratic should use this skill.\n---\n\n# ${rawName}\n\nReplace this with the guidance Umbratic should follow when this skill is relevant.\n`;
  await fs.promises.writeFile(path.join(skillDir, "SKILL.md"), template, "utf8");
  recordSkillChecksum(root, id, checksumPath(skillDir) ?? sha256Hex(template), "created");
  writeSkillSettings({ [id]: true });
  return {
    ok: true,
    skill: {
      id,
      name: rawName,
      description: "Briefly describe when Umbratic should use this skill.",
      enabled: true,
      source: "local",
      readOnly: false,
      checksum: checksumPath(skillDir) ?? sha256Hex(template),
      checksumStatus: "known_good",
      modified: false,
      provenance: "created",
    },
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
