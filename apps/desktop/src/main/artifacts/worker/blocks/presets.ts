/**
 * The five document presets.
 *
 * A preset is the entire typographic decision: type sizes, leading, space
 * between blocks, margins, and the two or three colours a document uses. The
 * spec picks one by name and never overrides any of it, so a document is either
 * one of five coherent designs or it is not produced.
 *
 * Both renderers read this table. DOCX turns it into styles and PDF turns it
 * into draw calls, which is why the numbers are in points — the one unit both
 * formats can express without rounding drift.
 */

import type { PresetName } from "./spec.js";

export type BlockPreset = {
  /** Point sizes. */
  title: number;
  subtitle: number;
  heading1: number;
  heading2: number;
  heading3: number;
  body: number;
  small: number;
  /** Multiple of type size. */
  lineHeight: number;
  /** Points of space before each kind of block. */
  spaceBeforeHeading: number;
  spaceBeforeParagraph: number;
  spaceBeforeList: number;
  /** Points, applied to every edge unless the renderer says otherwise. */
  margin: number;
  colors: {
    text: string;
    heading: string;
    muted: string;
    accent: string;
    rule: string;
    /** Callout backgrounds, one per style. */
    note: string;
    warning: string;
    decision: string;
    summary: string;
  };
  /** Whether body text is serif. Decides the font both renderers pick. */
  serif: boolean;
  /** Whether headings are numbered. */
  numberedHeadings: boolean;
};

const ink = {
  text: "1F2933",
  heading: "10161D",
  muted: "5A6672",
  accent: "2F6FD0",
  rule: "D8DEE5",
  note: "EEF3FA",
  warning: "FDF3E7",
  decision: "EEF7F0",
  summary: "F2F5F8",
};

const presets: Record<PresetName, BlockPreset> = {
  // The default: a memo someone reads once, on a screen, in a hurry.
  standard_business_brief: {
    title: 24,
    subtitle: 13,
    heading1: 16,
    heading2: 13,
    heading3: 11.5,
    body: 11,
    small: 9,
    lineHeight: 1.45,
    spaceBeforeHeading: 16,
    spaceBeforeParagraph: 8,
    spaceBeforeList: 6,
    margin: 72,
    colors: ink,
    serif: false,
    numberedHeadings: false,
  },
  // Dense on purpose: something kept open beside the work it describes.
  compact_reference_guide: {
    title: 20,
    subtitle: 11,
    heading1: 14,
    heading2: 12,
    heading3: 10.5,
    body: 10,
    small: 8.5,
    lineHeight: 1.3,
    spaceBeforeHeading: 12,
    spaceBeforeParagraph: 5,
    spaceBeforeList: 4,
    margin: 54,
    colors: ink,
    serif: false,
    numberedHeadings: true,
  },
  // Read front to back, so it gets serif body text and generous leading.
  narrative_proposal: {
    title: 28,
    subtitle: 14,
    heading1: 17,
    heading2: 14,
    heading3: 12,
    body: 11.5,
    lineHeight: 1.6,
    small: 9.5,
    spaceBeforeHeading: 20,
    spaceBeforeParagraph: 10,
    spaceBeforeList: 8,
    margin: 90,
    colors: { ...ink, accent: "6B4E9E" },
    serif: true,
    numberedHeadings: false,
  },
  // What Word gives you when nobody chose anything. The point is familiarity.
  simple_word_default: {
    title: 20,
    subtitle: 12,
    heading1: 16,
    heading2: 13,
    heading3: 12,
    body: 11,
    small: 9,
    lineHeight: 1.15,
    spaceBeforeHeading: 12,
    spaceBeforeParagraph: 0,
    spaceBeforeList: 0,
    margin: 72,
    colors: { ...ink, accent: "2E74B5", heading: "2E74B5" },
    serif: false,
    numberedHeadings: false,
  },
  // Something printed and filled in: wide leading and room beside every field.
  form_or_questionnaire: {
    title: 22,
    subtitle: 12,
    heading1: 15,
    heading2: 12.5,
    heading3: 11,
    body: 11,
    small: 9,
    lineHeight: 1.7,
    spaceBeforeHeading: 18,
    spaceBeforeParagraph: 10,
    spaceBeforeList: 8,
    margin: 72,
    colors: ink,
    serif: false,
    numberedHeadings: true,
  },
};

export function presetFor(name: PresetName): BlockPreset {
  return presets[name];
}

/** Page sizes in points, portrait. */
export const pageSizes = {
  Letter: { width: 612, height: 792 },
  A4: { width: 595.28, height: 841.89 },
} as const;

export function pageDimensions(
  size: "Letter" | "A4",
  orientation: "portrait" | "landscape",
): { width: number; height: number } {
  const base = pageSizes[size];
  return orientation === "landscape"
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

/** The colour a callout's rule and title take, given its background. */
export function calloutAccent(preset: BlockPreset, style: string): string {
  switch (style) {
    case "warning":
      return "B5661F";
    case "decision":
      return "2E7D4F";
    case "summary":
      return preset.colors.muted;
    default:
      return preset.colors.accent;
  }
}

export function calloutBackground(preset: BlockPreset, style: string): string {
  switch (style) {
    case "warning":
      return preset.colors.warning;
    case "decision":
      return preset.colors.decision;
    case "summary":
      return preset.colors.summary;
    default:
      return preset.colors.note;
  }
}
