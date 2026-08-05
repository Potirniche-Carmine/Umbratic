import {
  harnessSystemSkillIds,
  readPreviewHarnessProfile,
} from "./previewSupport";
import type {
  CapabilityProbeReport,
  CapabilityProbeResult,
  SkillInfo,
} from "../shared/desktopApi";

export function previewCapabilityReport(): CapabilityProbeReport {
  const checkedAt = new Date().toISOString();
  const probes: CapabilityProbeResult[] = [
    {
      id: "node-runtime",
      label: "Node runtime",
      category: "required",
      importance: "required",
      status: "available",
      version: "browser preview",
      purpose: "Runs the desktop and local harness code.",
      installHint: "Open the Electron app for real runtime probes.",
      workflows: ["desktop", "runner"],
      checkedAt,
    },
    {
      id: "runner-binary",
      label: "Umbratic runner",
      category: "required",
      importance: "required",
      status: "missing",
      purpose: "Starts local workspace tools for read, find, grep, search, write, edit, and command execution.",
      installHint: "Open the Electron app to check the runner bundle.",
      workflows: ["runner", "workspace tools"],
      checkedAt,
      message: "Electron preload is not available in browser preview.",
    },
    {
      id: "rg",
      label: "ripgrep",
      category: "recommended",
      importance: "recommended",
      status: "unknown",
      purpose: "Fast text search in workspaces.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["workspace search"],
      checkedAt,
    },
    {
      id: "uv",
      label: "uv",
      category: "recommended",
      importance: "recommended",
      status: "unknown",
      purpose: "Creates repeatable Python environments.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["Python", "artifacts"],
      checkedAt,
    },
    {
      id: "pdftoppm",
      label: "Poppler pdftoppm",
      category: "optional-artifacts",
      importance: "optional",
      status: "unknown",
      purpose: "Renders PDF pages to images for visual QA.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["PDF artifact", "visual QA"],
      checkedAt,
    },
    {
      id: "tesseract",
      label: "Tesseract OCR",
      category: "optional-artifacts",
      importance: "optional",
      status: "unknown",
      purpose: "Runs local OCR for image and scanned-PDF attachment digests.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["OCR artifact", "image attachment", "scanned PDF"],
      checkedAt,
    },
  ];
  const summary = probes.reduce<CapabilityProbeReport["summary"]>(
    (total, probe) => {
      total[probe.status] += 1;
      if (probe.status !== "available") {
        if (probe.importance === "required") total.requiredMissing += 1;
        if (probe.importance === "recommended") total.recommendedMissing += 1;
        if (probe.importance === "optional") total.optionalMissing += 1;
      }
      return total;
    },
    { available: 0, missing: 0, error: 0, unknown: 0, requiredMissing: 0, recommendedMissing: 0, optionalMissing: 0 },
  );
  return { checkedAt, probes, summary };
}

export const previewDefaultSkills: SkillInfo[] = [
  {
    id: "umbratic-skill-creator",
    name: "Skill Creator",
    description: "Use to create, revise, structure, and validate reusable Umbratic personal skills and their bundled resources.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-git-worktree",
    name: "Git Worktree",
    description: "Use for Git worktree isolation, branch/base awareness, review diffs, merge safety, and Umbratic task worktree behavior.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-markdown",
    name: "Markdown",
    description: "Use for Markdown structure, readable formatting, tables, docs, and plain-text artifact source.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-python",
    name: "Python",
    description: "Use for Python scripts, packages, tests, virtual environments, dependency setup, and Python-based verification.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-data-analysis",
    name: "Data Analysis",
    description: "Use for source-grounded analysis with pandas, data cleaning, validation, summaries, charts, and reproducible outputs.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-pdf",
    name: "PDF & OCR",
    description: "Use for PDF reading, page-aware review, polished PDF artifacts, and OCR of images or scanned documents.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-presentations",
    name: "Presentations",
    description: "Use for PowerPoint/PPTX outlines, slide copy, speaker notes, proposals, and customer-facing decks.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-documents",
    name: "Documents",
    description: "Use for DOCX/Word drafts, redlines, memos, proposals, and rendered document QA.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-spreadsheets",
    name: "Spreadsheets",
    description: "Use for XLSX/Excel workbooks, spreadsheet-ready tables, formulas, forecasts, and chart specs.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
];

const previewDefaultSkillGuidance: Record<string, string[]> = {
  "umbratic-skill-creator": [
    "Capture the intended triggers, workflow, outputs, and success criteria before drafting a skill.",
    "Keep SKILL.md concise, put detailed material in explicitly referenced resources, and validate the finished folder before handoff.",
    "Draft personal skills in the current workspace, then explain how to import and enable them from Umbratic's Skills settings.",
  ],
  "umbratic-git-worktree": [
    "Use the current worktree path as authoritative when an engineering run is isolated.",
    "Keep original branch, task branch, and base commit distinct when explaining Git state.",
    "Inspect status and diffs with non-destructive Git commands before summarizing or changing branch state.",
  ],
  "umbratic-markdown": [
    "Use clean Markdown when the user asks for docs, README content, tables, briefs, or paste-ready formatted text.",
    "Prefer simple headings, short paragraphs, bullets, and tables only when they improve scanning.",
    "Inspect nearby docs and config before using repository-local Markdown tooling.",
  ],
  "umbratic-python": [
    "Keep Python work inside the current workspace and prefer a workspace `.venv`.",
    "Prefer `uv` when available. Bare Python commands are allowed; if one fails because of the interpreter, environment, or dependencies, retry it through `uv run`.",
    "State runtime or dependency gaps when they affect verification.",
  ],
  "umbratic-data-analysis": [
    "Inspect columns, types, missing values, duplicates, ranges, and category cardinality before drawing conclusions.",
    "Use reproducible pandas scripts for cleaning, joins, aggregations, statistics, and chart-ready tables.",
    "Keep source data unchanged, label assumptions, and save derived outputs separately with validation checks.",
  ],
  "umbratic-pdf": [
    "Use local PDFs as page-aware source material; use extraction for text checks and rendered pages for layout fidelity.",
    "Use local OCR digests for images and scanned PDFs, preserving page locations, confidence warnings, and uncertain text.",
    "Generate PDFs with the configured Python artifact runtime and keep final files under `.umbratic/artifacts/pdf/` unless directed otherwise.",
    "Render with Poppler and inspect pages before claiming visual QA; state extraction, generation, or render gaps plainly.",
  ],
  "umbratic-presentations": [
    "Use this default for local PowerPoint/PPTX work only; do not route to Google Slides workflows from this guidance.",
    "Define audience, narrative, slide sequence, visual system, and speaker notes while keeping slide copy concise.",
    "Export or render with LibreOffice and inspect every slide before claiming visual QA; state PPTX runtime or export gaps plainly.",
  ],
  "umbratic-documents": [
    "Use this default for local DOCX/Word work only; do not route to Google Docs workflows from this guidance.",
    "Create documents with explicit styles, numbering, margins, table geometry, headers, footers, and stable page behavior.",
    "Render or export with LibreOffice and inspect every page before claiming visual QA; state DOCX runtime or render gaps plainly.",
  ],
  "umbratic-spreadsheets": [
    "Produce stable columns, short cell values, explicit formulas, and clear assumptions.",
    "Separate provided values, derived values, assumptions, and formulas.",
    "Provide paste-ready tables when an XLSX runtime is unavailable.",
  ],
};

export function previewSkillContent(skill: SkillInfo): string {
  const guidance = previewDefaultSkillGuidance[skill.id] ?? [skill.description];
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${guidance.map((line) => `- ${line}`).join("\n")}\n`;
}
