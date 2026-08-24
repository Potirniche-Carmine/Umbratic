/**
 * Theme presets and the `theme1.xml` they produce.
 *
 * The spec exposes a preset name and one optional accent colour, and nothing
 * else. Every other colour and every type size is derived here, which is what
 * keeps the model out of the business of picking contrast ratios — the failure
 * mode when a model does pick is grey text on a grey background, and no
 * structural check catches that because the file is perfectly valid.
 */

import { element, serializeDocument, type XmlNode } from "../xml.js";

export type ThemePresetName = "clean-light" | "clean-dark" | "warm";

export type ThemePalette = {
  /** Slide background. */
  background: string;
  /** Body text. */
  text: string;
  /** Titles and headings, usually a little stronger than body. */
  heading: string;
  /** Secondary text: captions, attributions, KPI labels. */
  muted: string;
  accent: string;
  /** Fill behind KPI cards, callouts, and table header rows. */
  surface: string;
  /** Hairlines: table rules, card borders. */
  line: string;
  majorFont: string;
  minorFont: string;
};

const presets: Record<ThemePresetName, ThemePalette> = {
  "clean-light": {
    background: "FFFFFF",
    text: "1F2933",
    heading: "10161D",
    muted: "5A6672",
    accent: "2F6FD0",
    surface: "F2F5F8",
    line: "D8DEE5",
    majorFont: "Calibri Light",
    minorFont: "Calibri",
  },
  "clean-dark": {
    background: "10161D",
    text: "E6EBF0",
    heading: "FFFFFF",
    muted: "9AA7B4",
    accent: "6BA4F8",
    surface: "1B242E",
    line: "2E3A46",
    majorFont: "Calibri Light",
    minorFont: "Calibri",
  },
  warm: {
    background: "FBF7F1",
    text: "2C2621",
    heading: "1A1511",
    muted: "6B6055",
    accent: "B5661F",
    surface: "F3EADC",
    line: "E0D3C1",
    majorFont: "Cambria",
    minorFont: "Calibri",
  },
};

export function isThemePreset(value: unknown): value is ThemePresetName {
  return value === "clean-light" || value === "clean-dark" || value === "warm";
}

/** Six digits, no alpha. An eight-digit value is a known corruption source. */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const digits = value.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(digits) ? digits : undefined;
}

export function resolvePalette(theme: unknown): ThemePalette {
  const object = typeof theme === "object" && theme !== null ? (theme as Record<string, unknown>) : {};
  const preset = isThemePreset(object.preset) ? object.preset : "clean-light";
  const base = presets[preset];
  const accent = normalizeHexColor(object.accent);
  return accent ? { ...base, accent } : { ...base };
}

/**
 * Relative luminance, used to decide what colour text goes on the accent.
 *
 * A brand accent can be anything from pale yellow to navy, and one hard-coded
 * choice of white or black label is wrong for half of them.
 */
export function readableTextOn(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "10161D" : "FFFFFF";
}

const drawingNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main";

function colorSlot(name: string, hex: string): XmlNode {
  return element(`a:${name}`, {}, [element("a:srgbClr", { val: hex })]);
}

export function themeXml(palette: ThemePalette): string {
  return serializeDocument(
    element("a:theme", { "xmlns:a": drawingNamespace, name: "Umbratic" }, [
      element("a:themeElements", {}, [
        element("a:clrScheme", { name: "Umbratic" }, [
          // dk1/lt1 are the text/background pair PowerPoint maps through the
          // master's clrMap; getting this pair wrong is what produces invisible
          // placeholder text on an otherwise valid deck.
          element("a:dk1", {}, [element("a:srgbClr", { val: palette.text })]),
          element("a:lt1", {}, [element("a:srgbClr", { val: palette.background })]),
          element("a:dk2", {}, [element("a:srgbClr", { val: palette.heading })]),
          element("a:lt2", {}, [element("a:srgbClr", { val: palette.surface })]),
          colorSlot("accent1", palette.accent),
          colorSlot("accent2", palette.muted),
          colorSlot("accent3", palette.heading),
          colorSlot("accent4", palette.line),
          colorSlot("accent5", palette.surface),
          colorSlot("accent6", palette.accent),
          colorSlot("hlink", palette.accent),
          colorSlot("folHlink", palette.muted),
        ]),
        element("a:fontScheme", { name: "Umbratic" }, [
          element("a:majorFont", {}, [
            element("a:latin", { typeface: palette.majorFont }),
            element("a:ea", { typeface: "" }),
            element("a:cs", { typeface: "" }),
          ]),
          element("a:minorFont", {}, [
            element("a:latin", { typeface: palette.minorFont }),
            element("a:ea", { typeface: "" }),
            element("a:cs", { typeface: "" }),
          ]),
        ]),
        formatScheme(),
      ]),
      element("a:objectDefaults"),
      element("a:extraClrSchemeLst"),
    ]),
  );
}

/**
 * The format scheme, which PowerPoint requires and never lets us omit.
 *
 * It is deliberately flat — solid fills, one hairline, no shadows. A generated
 * deck that quietly applies bevels and glows to every shape looks generated,
 * and there is no way for the model to turn them off because it never sees
 * this layer.
 */
function formatScheme(): XmlNode {
  const solid = element("a:solidFill", {}, [element("a:schemeClr", { val: "phClr" })]);
  const line = (width: number) =>
    element("a:ln", { w: width, cap: "flat", cmpd: "sng", algn: "ctr" }, [
      element("a:solidFill", {}, [element("a:schemeClr", { val: "phClr" })]),
      element("a:prstDash", { val: "solid" }),
    ]);
  return element("a:fmtScheme", { name: "Umbratic" }, [
    element("a:fillStyleLst", {}, [solid, solid, solid]),
    element("a:lnStyleLst", {}, [line(6350), line(12700), line(19050)]),
    element("a:effectStyleLst", {}, [
      element("a:effectStyle", {}, [element("a:effectLst")]),
      element("a:effectStyle", {}, [element("a:effectLst")]),
      element("a:effectStyle", {}, [element("a:effectLst")]),
    ]),
    element("a:bgFillStyleLst", {}, [solid, solid, solid]),
  ]);
}
