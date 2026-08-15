import type { SkillInfo } from "../shared/desktopApi";
import type { SkillSourceFilter } from "./rendererTypes";

function normalizeSkillPreviewHeading(value: string): string {
  return value.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function skillPreviewMarkdown(content: string, skillName: string): string {
  const lines = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim().split(/\r?\n/);
  if (lines[0]?.startsWith("# ") && normalizeSkillPreviewHeading(lines[0]) === normalizeSkillPreviewHeading(skillName)) {
    lines.shift();
    while (lines[0]?.trim() === "") lines.shift();
  }
  return lines.join("\n").trim();
}

export function filterSkillsBySource(skills: SkillInfo[], filter: SkillSourceFilter): SkillInfo[] {
  return skills.filter((skill) => skill.source === filter);
}

export function skillGovernanceLabel(skill: SkillInfo): string {
  if (skill.checksumStatus === "modified" || skill.modified) return "Modified";
  if (skill.checksumStatus === "untracked") return "Untracked";
  return "";
}
