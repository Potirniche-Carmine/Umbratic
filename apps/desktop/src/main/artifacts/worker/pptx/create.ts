/**
 * Building a .pptx from a spec.
 *
 * One function per layout, each returning shapes already placed by the geometry
 * table. Nothing here decides where a box goes — that is the point of the split.
 * What this module owns is which shapes a layout has, what they are called (the
 * names `inspect` reports and `edit` addresses), and how the spec's content maps
 * onto them.
 */

import * as path from "node:path";

import { fitInside, loadImage, type ImageFormat } from "../images.js";
import { OoxmlPackage } from "../package.js";
import { relationshipTypes, writeContentTypes, writeRelationships, type Relationship } from "../opc.js";
import { element, serializeDocument, type XmlNode } from "../xml.js";
import { chartXml } from "./chart.js";
import {
  attributionBox,
  bodyBox,
  captionBox,
  heroSubtitleBox,
  heroTitleBox,
  imageBox,
  kpiBoxes,
  leftColumnBox,
  quoteBox,
  rightColumnBox,
  sectionTitleBox,
  titleBox,
  type Box,
} from "./geometry.js";
import {
  baseContentTypes,
  chartContentType,
  notesSlideContentType,
  slideContentType,
  slideLayoutContentType,
  writePresentation,
  writeScaffold,
} from "./scaffold.js";
import {
  chartFrame,
  paragraph,
  picture,
  presentationNamespace,
  shapeTree,
  table,
  textBox,
  drawingNamespace,
  officeRelationshipNamespace,
  type TextStyle,
} from "./shapes.js";
import type { PresentationSpec, SlideSpec, SpecError } from "./spec.js";
import { resolvePalette, type ThemePalette } from "./theme.js";

const namespaces = {
  "xmlns:a": drawingNamespace,
  "xmlns:r": officeRelationshipNamespace,
  "xmlns:p": presentationNamespace,
};

/** Type scale, in points. One place, so a deck is typographically consistent. */
const typeScale = {
  heroTitle: 40,
  heroSubtitle: 20,
  sectionTitle: 32,
  slideTitle: 28,
  body: 18,
  subBullet: 16,
  caption: 13,
  quote: 24,
  attribution: 15,
  kpiValue: 36,
  kpiLabel: 13,
  kpiDelta: 13,
  tableBody: 14,
} as const;

export type CreateResult = {
  pack: OoxmlPackage;
  /** What inspect will report, computed while the slides are being built. */
  slideNames: string[][];
  errors: SpecError[];
};

export type CreateOptions = {
  spec: PresentationSpec;
  /** The workspace root, so `image: "assets/x.png"` resolves against it. */
  workspaceRoot: string;
  createdAt: string;
};

/** Per-slide state a builder accumulates while emitting shapes. */
type SlideBuild = {
  shapes: XmlNode[];
  relationships: Relationship[];
  /** Extra parts this slide needs, such as its chart. */
  parts: Array<{ name: string; content: string | Buffer; contentType?: string }>;
  names: string[];
  nextId: number;
};

export function createPresentation(options: CreateOptions): CreateResult {
  const { spec } = options;
  const palette = resolvePalette(spec.theme);
  const pack = OoxmlPackage.empty();
  const errors: SpecError[] = [];
  const types = baseContentTypes();
  for (let index = 0; index < 5; index += 1) {
    types.overrides.set(`/ppt/slideLayouts/slideLayout${index + 1}.xml`, slideLayoutContentType);
  }

  writeScaffold(pack, {
    palette,
    title: spec.meta.title,
    author: spec.meta.author,
    slideCount: spec.slides.length,
    createdAt: options.createdAt,
  });

  const slideParts: string[] = [];
  const slideNames: string[][] = [];
  const media = new Map<string, { part: string; format: ImageFormat }>();

  spec.slides.forEach((slide, index) => {
    const number = index + 1;
    const build: SlideBuild = { shapes: [], relationships: [], parts: [], names: [], nextId: 2 };
    // Every slide points at a layout. The choice is cosmetic here — geometry is
    // explicit — but it decides what a human sees in PowerPoint's layout picker
    // after they open the deck.
    build.relationships.push({
      id: "rId1",
      type: relationshipTypes.slideLayout,
      target: `../slideLayouts/slideLayout${layoutIndexFor(slide)}.xml`,
    });

    try {
      buildSlide(build, slide, number, palette, options.workspaceRoot, media, pack, types);
    } catch (error) {
      errors.push({
        path: `slides[${index}]`,
        message: String(error instanceof Error ? error.message : error),
      });
      return;
    }

    const slidePart = `ppt/slides/slide${number}.xml`;
    if (slide.notes) {
      const notesPart = `ppt/notesSlides/notesSlide${number}.xml`;
      pack.set(notesPart, notesSlideXml(slide.notes));
      types.overrides.set(`/${notesPart}`, notesSlideContentType);
      writeRelationships(pack, notesPart, [
        { id: "rId1", type: relationshipTypes.slide, target: `../slides/slide${number}.xml` },
      ]);
      build.relationships.push({
        id: `rId${build.relationships.length + 1}`,
        type: relationshipTypes.notesSlide,
        target: `../notesSlides/notesSlide${number}.xml`,
      });
    }

    for (const part of build.parts) {
      pack.set(part.name, part.content);
      if (part.contentType) types.overrides.set(`/${part.name}`, part.contentType);
    }
    pack.set(slidePart, slideXml(build.shapes));
    writeRelationships(pack, slidePart, build.relationships);
    types.overrides.set(`/${slidePart}`, slideContentType);
    slideParts.push(slidePart);
    slideNames.push(build.names);
  });

  writePresentation(pack, slideParts);
  writeContentTypes(pack, types);
  return { pack, slideNames, errors };
}

function layoutIndexFor(slide: SlideSpec): number {
  switch (slide.layout) {
    case "title":
    case "closing":
      return 1;
    case "section":
      return 3;
    case "two-column":
      return 4;
    case "image":
    case "chart":
      return 5;
    default:
      return 2;
  }
}

function slideXml(shapes: XmlNode[]): string {
  return serializeDocument(
    element("p:sld", namespaces, [
      element("p:cSld", {}, [shapeTree(shapes)]),
      element("p:clrMapOvr", {}, [element("a:masterClrMapping")]),
    ]),
  );
}

function notesSlideXml(notes: string): string {
  return serializeDocument(
    element("p:notes", namespaces, [
      element("p:cSld", {}, [
        shapeTree([
          textBox(2, "Notes Placeholder 1", { x: 0, y: 0, width: 6_858_000, height: 4_500_000 }, [
            ...notes
              .split("\n")
              .map((line) => paragraph(line, { size: 12, color: "000000" })),
          ]),
        ]),
      ]),
      element("p:clrMapOvr", {}, [element("a:masterClrMapping")]),
    ]),
  );
}

function addShape(build: SlideBuild, name: string, make: (id: number, name: string) => XmlNode): void {
  const id = build.nextId;
  build.nextId += 1;
  build.shapes.push(make(id, name));
  build.names.push(name);
}

function buildSlide(
  build: SlideBuild,
  slide: SlideSpec,
  number: number,
  palette: ThemePalette,
  workspaceRoot: string,
  media: Map<string, { part: string; format: ImageFormat }>,
  pack: OoxmlPackage,
  types: ReturnType<typeof baseContentTypes>,
): void {
  const titleStyle: TextStyle = {
    size: typeScale.slideTitle,
    color: palette.heading,
    bold: true,
    typeface: "+mj-lt",
  };
  const bodyStyle: TextStyle = { size: typeScale.body, color: palette.text, lineSpacing: 105 };

  switch (slide.layout) {
    case "title":
    case "closing": {
      addShape(build, "Title 1", (id, name) =>
        textBox(
          id,
          name,
          heroTitleBox,
          [paragraph(slide.title ?? "", { ...titleStyle, size: typeScale.heroTitle, align: "ctr" })],
          { anchor: "b" },
        ),
      );
      if (slide.subtitle) {
        addShape(build, "Subtitle 2", (id, name) =>
          textBox(id, name, heroSubtitleBox, [
            paragraph(slide.subtitle!, {
              size: typeScale.heroSubtitle,
              color: palette.muted,
              align: "ctr",
            }),
          ]),
        );
      }
      break;
    }
    case "section": {
      addShape(build, "Title 1", (id, name) =>
        textBox(
          id,
          name,
          sectionTitleBox,
          [paragraph(slide.title ?? "", { ...titleStyle, size: typeScale.sectionTitle, align: "ctr" })],
          { anchor: "ctr" },
        ),
      );
      break;
    }
    case "bullets": {
      addTitle(build, slide, titleStyle);
      addShape(build, "Content 2", (id, name) =>
        textBox(
          id,
          name,
          bodyBox,
          (slide.bullets ?? []).map((bullet, index) =>
            paragraph(
              bullet.text,
              bullet.level === 0 ? bodyStyle : { ...bodyStyle, size: typeScale.subBullet, color: palette.muted },
              { bullet: true, level: bullet.level, spaceBefore: index === 0 ? 0 : 10 },
            ),
          ),
        ),
      );
      break;
    }
    case "two-column": {
      addTitle(build, slide, titleStyle);
      addColumn(build, "Left 2", slide.left, leftColumnBox, palette, bodyStyle, workspaceRoot, media, pack, types, `slides[${number - 1}].left`);
      addColumn(build, "Right 3", slide.right, rightColumnBox, palette, bodyStyle, workspaceRoot, media, pack, types, `slides[${number - 1}].right`);
      break;
    }
    case "image": {
      if (slide.title) addTitle(build, slide, titleStyle);
      const embedded = embedImage(slide.image!, workspaceRoot, media, pack, types, build);
      addShape(build, "Picture 2", (id, name) =>
        picture(id, name, embedded.relationshipId, fitInside(embedded.size, imageBox), slide.alt ?? slide.caption ?? ""),
      );
      if (slide.caption) {
        addShape(build, "Caption 3", (id, name) =>
          textBox(id, name, captionBox, [
            paragraph(slide.caption!, {
              size: typeScale.caption,
              color: palette.muted,
              align: "ctr",
            }),
          ]),
        );
      }
      break;
    }
    case "chart": {
      addTitle(build, slide, titleStyle);
      const chartPart = `ppt/charts/chart${number}.xml`;
      build.parts.push({
        name: chartPart,
        content: chartXml(slide.chart!, undefined, palette),
        contentType: chartContentType,
      });
      const relationshipId = `rId${build.relationships.length + 1}`;
      build.relationships.push({
        id: relationshipId,
        type: relationshipTypes.chart,
        target: `../charts/chart${number}.xml`,
      });
      addShape(build, "Chart 2", (id, name) => chartFrame(id, name, relationshipId, bodyBox));
      break;
    }
    case "table": {
      addTitle(build, slide, titleStyle);
      const columns = slide.columns ?? [];
      const widths = distributeWidths(bodyBox.width, columns.length);
      const rows = [
        columns.map((header) => ({ text: header, header: true })),
        ...(slide.rows ?? []).map((row) => row.map((cell) => ({ text: cell }))),
      ];
      // A table shorter than the body box should not be stretched to fill it:
      // twelve rows of whitespace reads as a rendering fault.
      const height = Math.min(bodyBox.height, rows.length * 420_000 + 120_000);
      addShape(build, "Table 2", (id, name) =>
        table(id, name, { ...bodyBox, height }, widths, rows, palette, typeScale.tableBody),
      );
      break;
    }
    case "kpis": {
      addTitle(build, slide, titleStyle);
      const items = slide.items ?? [];
      const boxes = kpiBoxes(items.length);
      items.forEach((item, index) => {
        const box = boxes[index]!;
        addShape(build, `KPI ${index + 1}`, (id, name) =>
          textBox(
            id,
            name,
            box,
            [
              paragraph(item.value, {
                size: typeScale.kpiValue,
                color: palette.accent,
                bold: true,
                align: "ctr",
                typeface: "+mj-lt",
              }),
              paragraph(item.label, {
                size: typeScale.kpiLabel,
                color: palette.muted,
                align: "ctr",
              }),
              ...(item.delta
                ? [
                    paragraph(item.delta, {
                      size: typeScale.kpiDelta,
                      color: deltaColor(item.delta, palette),
                      align: "ctr",
                      bold: true,
                    }),
                  ]
                : []),
            ],
            { anchor: "ctr", fill: palette.surface, outline: palette.line },
          ),
        );
      });
      break;
    }
    case "quote": {
      addShape(build, "Quote 1", (id, name) =>
        textBox(
          id,
          name,
          quoteBox,
          [
            paragraph(`“${slide.quote}”`, {
              size: typeScale.quote,
              color: palette.heading,
              italic: true,
              align: "ctr",
              typeface: "+mj-lt",
              lineSpacing: 115,
            }),
          ],
          { anchor: "ctr" },
        ),
      );
      if (slide.attribution) {
        addShape(build, "Attribution 2", (id, name) =>
          textBox(id, name, attributionBox, [
            paragraph(`— ${slide.attribution}`, {
              size: typeScale.attribution,
              color: palette.muted,
              align: "ctr",
            }),
          ]),
        );
      }
      break;
    }
  }
}

function addTitle(build: SlideBuild, slide: SlideSpec, style: TextStyle): void {
  addShape(build, "Title 1", (id, name) =>
    textBox(id, name, titleBox, [paragraph(slide.title ?? "", style)], { anchor: "ctr" }),
  );
}

/**
 * A delta reads as good or bad, and the sign is the only signal available.
 *
 * This is the one colour decision made from content rather than from the theme,
 * and it is worth it: a red "+12%" is actively misleading.
 */
function deltaColor(delta: string, palette: ThemePalette): string {
  if (delta.trimStart().startsWith("-")) return "C0563B";
  if (delta.trimStart().startsWith("+")) return "2E7D4F";
  return palette.muted;
}

function distributeWidths(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const widths = Array.from({ length: count }, () => base);
  // The remainder goes on the last column so the widths sum to the box exactly;
  // a table narrower than its frame draws a visible gap on the right edge.
  widths[count - 1] = total - base * (count - 1);
  return widths;
}

function addColumn(
  build: SlideBuild,
  name: string,
  column: { bullets?: Array<{ text: string; level: number }>; image?: string; text?: string } | undefined,
  box: Box,
  palette: ThemePalette,
  bodyStyle: TextStyle,
  workspaceRoot: string,
  media: Map<string, { part: string; format: ImageFormat }>,
  pack: OoxmlPackage,
  types: ReturnType<typeof baseContentTypes>,
  specPath: string,
): void {
  if (!column) return;
  if (column.image) {
    const embedded = embedImage(column.image, workspaceRoot, media, pack, types, build, specPath);
    addShape(build, name, (id, shapeName) =>
      picture(id, shapeName, embedded.relationshipId, fitInside(embedded.size, box), ""),
    );
    return;
  }
  const paragraphs = column.bullets
    ? column.bullets.map((bullet, index) =>
        paragraph(
          bullet.text,
          bullet.level === 0 ? bodyStyle : { ...bodyStyle, size: typeScale.subBullet, color: palette.muted },
          { bullet: true, level: bullet.level, spaceBefore: index === 0 ? 0 : 10 },
        ),
      )
    : [paragraph(column.text ?? "", bodyStyle)];
  addShape(build, name, (id, shapeName) => textBox(id, shapeName, box, paragraphs));
}

/**
 * Embeds one image, reusing the media part when the same file appears twice.
 *
 * The path is resolved against the workspace root and then checked to still be
 * inside it. The runner already confined `path` and `out`, but an image path
 * lives inside the spec, which the runner treats as opaque — so the containment
 * check for it has to happen here, where the path is finally understood.
 */
function embedImage(
  relativePath: string,
  workspaceRoot: string,
  media: Map<string, { part: string; format: ImageFormat }>,
  pack: OoxmlPackage,
  types: ReturnType<typeof baseContentTypes>,
  build: SlideBuild,
  specPath = "image",
): { relationshipId: string; size: { width: number; height: number } } {
  const absolute = path.resolve(workspaceRoot, relativePath);
  const root = path.resolve(workspaceRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`${specPath} ${relativePath} is outside the workspace`);
  }
  const image = loadImage(absolute);
  const existing = media.get(absolute);
  const part =
    existing?.part
    ?? `ppt/media/image${media.size + 1}.${image.format === "jpeg" ? "jpeg" : image.format}`;
  if (!existing) {
    pack.set(part, image.bytes);
    types.defaults.set(image.format === "jpeg" ? "jpeg" : image.format, `image/${image.format}`);
    media.set(absolute, { part, format: image.format });
  }
  const relationshipId = `rId${build.relationships.length + 1}`;
  build.relationships.push({
    id: relationshipId,
    type: relationshipTypes.image,
    target: `../media/${part.slice(part.lastIndexOf("/") + 1)}`,
  });
  return { relationshipId, size: { width: image.width, height: image.height } };
}
