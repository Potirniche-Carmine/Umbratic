import type { HarnessProfileId } from "./desktopApiTypes";

export const systemSkillIds = [
  "umbratic-skill-creator",
  "umbratic-git-worktree",
  "umbratic-markdown",
  "umbratic-python",
  "umbratic-pdf",
  "umbratic-data-analysis",
  "umbratic-presentations",
  "umbratic-documents",
  "umbratic-spreadsheets",
  "umbratic-cmake",
  "umbratic-discovery",
  "umbratic-product-spec",
  "umbratic-security-review",
  "umbratic-marketing-brief",
  "umbratic-sales-enablement",
  "umbratic-competitive-research",
  "umbratic-news-briefing",
] as const;

export const harnessSystemSkillIds: Record<HarnessProfileId, ReadonlySet<string>> = {
  engineering: new Set([
    "umbratic-skill-creator",
    "umbratic-git-worktree",
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-cmake",
    "umbratic-discovery",
    "umbratic-product-spec",
    "umbratic-security-review",
  ]),
  marketing: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
    "umbratic-discovery",
    "umbratic-marketing-brief",
    "umbratic-competitive-research",
    "umbratic-news-briefing",
  ]),
  sales: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
    "umbratic-discovery",
    "umbratic-sales-enablement",
    "umbratic-competitive-research",
    "umbratic-news-briefing",
  ]),
};

export function systemSkillEnabled(
  skillId: string,
  profile: HarnessProfileId,
  settings: Record<string, boolean>,
): boolean {
  if (Object.hasOwn(settings, skillId)) return settings[skillId] === true;
  return harnessSystemSkillIds[profile].has(skillId);
}

export function systemSkillEnabledFlags(profile: HarnessProfileId): Record<string, boolean> {
  const enabled = harnessSystemSkillIds[profile];
  return Object.fromEntries(systemSkillIds.map((id) => [id, enabled.has(id)]));
}
