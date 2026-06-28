import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readSkillSettings, writeSkillSettings } from "./storage";
import type { HarnessProfileId } from "./types";
import { pathInside } from "./utils";

export type SkillSource = "harness" | "local";
export type SkillInfo = { id: string; name: string; description: string; enabled: boolean; source: SkillSource; readOnly: boolean };
export type SkillDocument = SkillInfo & { path: string; content: string };
export type PromptSkillInfo = {
  id: string;
  name: string;
  description: string;
  instructionPath: string;
  content: string;
  fullContent: boolean;
  source: "harness" | "local";
  reason: "harness_mode" | "explicit_request" | "strong_match" | "metadata";
};
type HarnessSkillInfo = PromptSkillInfo & {
  profiles: HarnessProfileId[];
  autoSelect: "always" | "match";
  matchPattern?: RegExp;
};

const skillFileByteLimit = 512 * 1024;

const harnessSkillCatalog: HarnessSkillInfo[] = [
  {
    id: "harness-engineering-workspace",
    name: "Engineering Workspace",
    description: "Use local workspace tools for code inspection, precise edits, tests, and review-ready summaries.",
    instructionPath: "harness://engineering/workspace",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["engineering"],
    autoSelect: "always",
    content: [
      "Use the local workspace as the source of truth.",
      "Prefer read/search before editing. Prefer exact edits and reviewable file changes.",
      "Run the narrowest available verification for the changed area and report any verification gap clearly.",
      "Do not assume Python, CMake, Markdown, Git, or worktree policies unless the task and available profile facts call for them.",
    ].join("\n"),
  },
  {
    id: "harness-markdown",
    name: "Markdown Writing",
    description: "Use for Markdown structure, readable formatting, tables, docs, and plain-text artifact source.",
    instructionPath: "harness://shared/markdown",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["engineering", "marketing", "sales"],
    autoSelect: "match",
    matchPattern: /\b(markdown|md|readme|docs?|documentation|table|formatted text|paste-ready|plain[-\s]?text)\b/i,
    content: [
      "Use clean Markdown when the user asks for Markdown, docs, README content, tables, briefs, or paste-ready formatted text.",
      "Prefer simple headings, short paragraphs, bullets, and tables only when they improve scanning.",
      "Keep Markdown portable: avoid HTML, custom components, fragile nested lists, and formatting that depends on a specific renderer.",
      "When writing artifact source for PDFs, slides, or one-pagers, use clear sections that can be converted into the target format.",
    ].join("\n"),
  },
  {
    id: "harness-pdf-artifacts",
    name: "PDF Artifacts",
    description: "Use for PDF reading, summarization, page-aware review, and PDF-backed business artifacts.",
    instructionPath: "harness://artifacts/pdf",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["marketing", "sales"],
    autoSelect: "match",
    matchPattern: /\b(pdf|one[-\s]?pager|report|whitepaper|white paper)\b/i,
    content: [
      "Use PDF attachments as local source material when provided. Use text extraction for quick content checks, not layout fidelity.",
      "For PDFs, prefer a Codex-style workflow: extract with `pdfplumber` or `pypdf`, generate with `reportlab` when needed, render pages with Poppler `pdftoppm`, and inspect rendered pages for visual QA.",
      "When pages are rendered as images, ground visual observations in the rendered pages and call out pages that were not available.",
      "For PDF deliverables, produce concise source content and structure that can be rendered by the configured artifact workflow.",
      "Do not claim a PDF was rendered, visually inspected, or exported unless the tool results or attachments show that happened.",
    ].join("\n"),
  },
  {
    id: "harness-presentation-artifacts",
    name: "Presentation Artifacts",
    description: "Use for PowerPoint/PPTX outlines, slide copy, speaker notes, proposals, and customer-facing decks.",
    instructionPath: "harness://artifacts/presentations",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["marketing", "sales"],
    autoSelect: "match",
    matchPattern: /\b(powerpoint|pptx|presentation|deck|slides?|speaker notes?)\b/i,
    content: [
      "For slide or PowerPoint work, produce deck-ready structure: title, audience, slide sequence, key message, visual direction, and speaker notes when useful.",
      "Keep claims grounded in supplied source material. Do not invent customer metrics, logos, case studies, pricing, or legal promises.",
      "If a local PPTX file must be created, use the configured artifact runtime only when available; do not default to ad hoc `python-pptx` for net-new decks.",
      "Render or inspect exported slides before claiming visual QA, and state any rendering gap plainly.",
      "Prefer concise slide copy over long prose. Put supporting detail in notes or appendix sections.",
    ].join("\n"),
  },
  {
    id: "harness-document-artifacts",
    name: "Document Artifacts",
    description: "Use for DOCX/Word drafts, redlines, memos, proposals, and rendered document QA.",
    instructionPath: "harness://artifacts/documents",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["marketing", "sales"],
    autoSelect: "match",
    matchPattern: /\b(docx|word document|word|redline|memo|proposal document|document draft)\b/i,
    content: [
      "For DOCX or Word artifacts, prefer a DOCX-first workflow with stable headings, tables, lists, margins, and styles.",
      "Use supplied source material as facts. Mark assumptions and do not invent customer, legal, pricing, or compliance claims.",
      "When a render path is available, export or render pages and inspect them before claiming visual QA.",
      "If the artifact runtime is missing, provide clean structured source content and state the generation or rendering gap.",
    ].join("\n"),
  },
  {
    id: "harness-spreadsheet-artifacts",
    name: "Spreadsheet Artifacts",
    description: "Use for XLSX/Excel workbooks, spreadsheet-ready tables, formulas, forecasts, and chart specs.",
    instructionPath: "harness://artifacts/spreadsheets",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["marketing", "sales"],
    autoSelect: "match",
    matchPattern: /\b(xlsx|excel|spreadsheet|workbook|worksheet|forecast|formula|chart|csv)\b/i,
    content: [
      "For spreadsheet artifacts, produce stable columns, short cell values, explicit formulas, and clear assumptions.",
      "Prefer a configured artifact runtime for XLSX creation, formatting, formulas, charts, and recalculation checks.",
      "Do not invent source data. Separate provided values, derived values, assumptions, and formulas.",
      "If no XLSX runtime is available, provide a paste-ready Markdown or CSV-shaped table and state the generation gap.",
    ].join("\n"),
  },
  {
    id: "harness-sales-enablement",
    name: "Sales Enablement",
    description: "Use for account notes, discovery, objections, proposals, mutual plans, and concise buyer-facing artifacts.",
    instructionPath: "harness://sales/enablement",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["sales"],
    autoSelect: "always",
    content: [
      "Shape outputs for practical selling workflows: account context, pain, value hypothesis, proof needed, next step, and owner.",
      "Separate known facts from assumptions. Mark assumptions plainly when source material is incomplete.",
      "For tables or spreadsheet-ready outputs, use stable columns and short cell values that can be pasted into Sheets or Excel.",
      "Keep tone direct, specific, and customer-safe.",
    ].join("\n"),
  },
  {
    id: "harness-marketing-content",
    name: "Marketing Content",
    description: "Use for positioning, launch copy, campaign briefs, web copy, messaging, and brand-safe content drafts.",
    instructionPath: "harness://marketing/content",
    source: "harness",
    fullContent: true,
    reason: "harness_mode",
    profiles: ["marketing"],
    autoSelect: "always",
    content: [
      "Shape outputs around audience, offer, message hierarchy, proof, channel, and call to action.",
      "Avoid unsupported superlatives, fabricated metrics, customer claims, or competitive assertions.",
      "When creating campaign or web copy, provide scan-friendly variants and label where each variant is intended to be used.",
      "For artifact requests, provide clean source structure for slides, PDFs, one-pagers, briefs, or tables.",
    ].join("\n"),
  },
];

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
    source: "local",
    readOnly: false,
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
    fullContent: false,
    source: "local",
    reason: "metadata",
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

function normalizedTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 4),
  );
}

function skillStronglyMatchesPrompt(skill: Pick<PromptSkillInfo, "id" | "name" | "description">, userPrompt: string): boolean {
  const promptTerms = normalizedTerms(userPrompt);
  if (promptTerms.size === 0) return false;
  const skillTerms = normalizedTerms(`${skill.id} ${skill.name} ${skill.description}`);
  let matches = 0;
  for (const term of skillTerms) {
    if (promptTerms.has(term)) matches += 1;
    if (matches >= 2) return true;
  }
  const name = skill.name.toLowerCase();
  return name.length >= 4 && userPrompt.toLowerCase().includes(name);
}

function harnessSkillInfo(settings: Record<string, boolean>): SkillInfo[] {
  return harnessSkillCatalog.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: settings[skill.id] !== false,
    source: "harness" as const,
    readOnly: true,
  }));
}

function harnessSkillById(id: string): HarnessSkillInfo | undefined {
  return harnessSkillCatalog.find((skill) => skill.id === id);
}

export function harnessSkillsForProfile(profile: HarnessProfileId, userPrompt: string, settings = readSkillSettings()): PromptSkillInfo[] {
  return harnessSkillCatalog
    .filter((skill) => skill.profiles.includes(profile))
    .filter((skill) => settings[skill.id] !== false)
    .filter((skill) => {
      if (skill.autoSelect === "always") return true;
      if (skill.matchPattern?.test(userPrompt)) return true;
      return skillStronglyMatchesPrompt(skill, userPrompt);
    })
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructionPath: skill.instructionPath,
      content: skill.content,
      fullContent: skill.fullContent,
      source: skill.source,
      reason: skill.reason,
    }));
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
      fullContent: requestedIds.has(skill.id) || skillStronglyMatchesPrompt(skill, userPrompt),
      reason: requestedIds.has(skill.id)
        ? "explicit_request" as const
        : skillStronglyMatchesPrompt(skill, userPrompt)
          ? "strong_match" as const
          : "metadata" as const,
    }))
    .filter((skill) => skill.enabled || skill.requested)
    .sort((left, right) =>
      Number(right.requested) - Number(left.requested) ||
      Number(right.fullContent) - Number(left.fullContent) ||
      left.name.localeCompare(right.name)
    )
    .slice(0, 24);
}

export async function listSkills(
  directory = skillsDirectoryPath(),
  settings = readSkillSettings(),
): Promise<{ skills: SkillInfo[]; directory: string }> {
  const skills: SkillInfo[] = harnessSkillInfo(settings);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return { skills, directory };
  }

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
      skills.push({ id: entry.name, name, description, enabled: settings[entry.name] !== false, source: "local", readOnly: false });
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
      skills.push({ id, name, description, enabled: settings[id] !== false, source: "local", readOnly: false });
    }
  }

  skills.sort((a, b) => Number(a.readOnly) - Number(b.readOnly) || a.name.localeCompare(b.name));
  return { skills, directory };
}

export async function getSkillDocument(
  input: { id?: string },
  directory = skillsDirectoryPath(),
): Promise<{ ok: true; skill: SkillDocument; directory: string } | { ok: false; message: string }> {
  const id = (input?.id ?? "").trim();
  if (!isValidSkillId(id)) return { ok: false, message: "Invalid skill id." };
  const harnessSkill = harnessSkillById(id);
  if (harnessSkill) {
    return {
      ok: true,
      directory,
      skill: {
        id: harnessSkill.id,
        name: harnessSkill.name,
        description: harnessSkill.description,
        enabled: readSkillSettings()[harnessSkill.id] !== false,
        source: "harness",
        readOnly: true,
        path: harnessSkill.instructionPath,
        content: harnessSkill.content,
      },
    };
  }
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
  if (harnessSkillById(id)) return { ok: false, message: "Built-in harness skills are read-only." };
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
    skill: {
      id,
      name: rawName,
      description: "Briefly describe when Umbratic AI should use this skill.",
      enabled: true,
      source: "local",
      readOnly: false,
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
