/**
 * Fixed slide geometry.
 *
 * The model never sends a coordinate. It picks a layout name, and this table
 * decides where the boxes go. That is the whole reason overlap and off-slide
 * cannot happen on create: there is no code path that places a shape anywhere
 * except one of these rectangles, so the only geometry failure left is text
 * that does not fit the box it was given — which is measurable, and which the
 * QA pass reports with the one instruction that fixes it.
 */

/** English Metric Units per inch, the unit every OOXML offset is in. */
export const emuPerInch = 914_400;
export const emuPerPoint = 12_700;

/** 16:9, the only aspect this builds. 13.333in × 7.5in. */
export const slideWidth = 12_192_000;
export const slideHeight = 6_858_000;

export type Box = { x: number; y: number; width: number; height: number };

export function inches(value: number): number {
  return Math.round(value * emuPerInch);
}

export function pointsToEmu(value: number): number {
  return Math.round(value * emuPerPoint);
}

export function emuToPoints(value: number): number {
  return value / emuPerPoint;
}

const margin = inches(0.7);
const contentWidth = slideWidth - margin * 2;

/** Where a title sits on every layout that has one. */
export const titleBox: Box = {
  x: margin,
  y: inches(0.55),
  width: contentWidth,
  height: inches(1.0),
};

const bodyTop = inches(1.75);
const bodyHeight = slideHeight - bodyTop - inches(0.65);

export const bodyBox: Box = {
  x: margin,
  y: bodyTop,
  width: contentWidth,
  height: bodyHeight,
};

const columnGap = inches(0.4);
const columnWidth = Math.round((contentWidth - columnGap) / 2);

export const leftColumnBox: Box = {
  x: margin,
  y: bodyTop,
  width: columnWidth,
  height: bodyHeight,
};

export const rightColumnBox: Box = {
  x: margin + columnWidth + columnGap,
  y: bodyTop,
  width: columnWidth,
  height: bodyHeight,
};

/** A centred block for the title and closing layouts. */
export const heroTitleBox: Box = {
  x: margin,
  y: inches(2.35),
  width: contentWidth,
  height: inches(1.6),
};

export const heroSubtitleBox: Box = {
  x: margin,
  y: inches(4.0),
  width: contentWidth,
  height: inches(1.0),
};

export const sectionTitleBox: Box = {
  x: margin,
  y: inches(2.9),
  width: contentWidth,
  height: inches(1.3),
};

export const quoteBox: Box = {
  x: inches(1.4),
  y: inches(2.1),
  width: slideWidth - inches(2.8),
  height: inches(2.2),
};

export const attributionBox: Box = {
  x: inches(1.4),
  y: inches(4.45),
  width: slideWidth - inches(2.8),
  height: inches(0.6),
};

export const captionBox: Box = {
  x: margin,
  y: slideHeight - inches(1.0),
  width: contentWidth,
  height: inches(0.5),
};

/** The picture area on the image layout, above the caption. */
export const imageBox: Box = {
  x: margin,
  y: bodyTop,
  width: contentWidth,
  height: bodyHeight - inches(0.55),
};

/** Two to four KPI cards, laid out edge to edge across the content width. */
export function kpiBoxes(count: number): Box[] {
  const gap = inches(0.35);
  const width = Math.round((contentWidth - gap * (count - 1)) / count);
  const height = inches(2.0);
  const y = inches(2.5);
  return Array.from({ length: count }, (_, index) => ({
    x: margin + index * (width + gap),
    y,
    width,
    height,
  }));
}

/** Inset applied inside every text box, matching PowerPoint's own defaults. */
export const textInset = {
  left: pointsToEmu(7.2),
  right: pointsToEmu(7.2),
  top: pointsToEmu(3.6),
  bottom: pointsToEmu(3.6),
};

/** The usable width for text inside a box, in points. */
export function textWidthPoints(box: Box): number {
  return emuToPoints(box.width - textInset.left - textInset.right);
}

export function textHeightPoints(box: Box): number {
  return emuToPoints(box.height - textInset.top - textInset.bottom);
}

export function boxesOverlap(left: Box, right: Box): boolean {
  return (
    left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
  );
}

export function boxIsOnSlide(box: Box): boolean {
  return (
    box.x >= 0
    && box.y >= 0
    && box.x + box.width <= slideWidth
    && box.y + box.height <= slideHeight
  );
}
