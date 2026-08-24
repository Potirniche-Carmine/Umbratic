/**
 * The PPTX spec: what the model is allowed to send, and the errors it gets back
 * when it sends something else.
 *
 * Every failure carries a JSON path into the spec the model just wrote, because
 * that is the one piece of information that makes a repair a single edit rather
 * than a re-derivation. "7 items; max 6" at `slides[3].bullets` is actionable;
 * "invalid presentation" is a second round trip.
 */

export type SpecError = { path: string; message: string };

export const limits = {
  slides: 60,
  titleCharacters: 60,
  bulletsPerSlide: 6,
  bulletCharacters: 90,
  bulletLevels: 2,
  tableColumns: 8,
  tableRows: 12,
  kpisMin: 2,
  kpisMax: 4,
  chartSeries: 6,
  chartCategories: 24,
  pieSlices: 12,
  notesCharacters: 2_000,
} as const;

export const layoutNames = [
  "title",
  "section",
  "bullets",
  "two-column",
  "image",
  "chart",
  "table",
  "kpis",
  "quote",
  "closing",
] as const;

export type SlideLayoutName = (typeof layoutNames)[number];

export const chartTypes = ["bar", "column", "line", "pie", "scatter"] as const;
export type ChartType = (typeof chartTypes)[number];

export type BulletItem = { text: string; level: number };

export type ChartSpec = {
  type: ChartType;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
};

export type ColumnContent = {
  bullets?: BulletItem[];
  image?: string;
  text?: string;
};

export type SlideSpec = {
  layout: SlideLayoutName;
  title?: string;
  subtitle?: string;
  notes?: string;
  bullets?: BulletItem[];
  left?: ColumnContent;
  right?: ColumnContent;
  image?: string;
  caption?: string;
  alt?: string;
  chart?: ChartSpec;
  columns?: string[];
  rows?: string[][];
  items?: Array<{ label: string; value: string; delta?: string }>;
  quote?: string;
  attribution?: string;
};

export type TemplateSpec = {
  path: string;
  mode: "reuse" | "style";
  keepSlides: Array<number | "last">;
};

export type PresentationSpec = {
  theme: Record<string, unknown>;
  template?: TemplateSpec;
  meta: { title: string; author: string };
  slides: SlideSpec[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SpecReader {
  readonly errors: SpecError[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  text(value: unknown, path: string, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(path, "is required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.fail(path, "must be a string");
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (required) this.fail(path, "must not be empty");
      return undefined;
    }
    if (trimmed.length > max) {
      this.fail(path, `is ${trimmed.length} characters; max ${max} — shorten it`);
      return undefined;
    }
    return trimmed;
  }
}

/**
 * Reads and checks a whole presentation spec.
 *
 * Every problem is collected rather than thrown at the first one: a model that
 * gets one error per round trip spends three rounds on a slide it could have
 * fixed in one.
 */
export function readPresentationSpec(input: unknown): {
  spec?: PresentationSpec;
  errors: SpecError[];
} {
  const reader = new SpecReader();
  if (!isRecord(input)) {
    return { errors: [{ path: "spec", message: "must be an object" }] };
  }
  const slidesValue = input.slides;
  if (!Array.isArray(slidesValue)) {
    reader.fail("slides", "must be an array of slide objects");
    return { errors: reader.errors };
  }
  if (slidesValue.length === 0) {
    reader.fail("slides", "must contain at least one slide");
    return { errors: reader.errors };
  }
  if (slidesValue.length > limits.slides) {
    reader.fail(
      "slides",
      `has ${slidesValue.length} slides; max ${limits.slides} — split this into more than one deck`,
    );
    return { errors: reader.errors };
  }

  const slides = slidesValue.map((slide, index) => readSlide(reader, slide, `slides[${index}]`));
  const meta = isRecord(input.meta) ? input.meta : {};
  const template = readTemplate(reader, input.template);
  const spec: PresentationSpec = {
    theme: isRecord(input.theme) ? input.theme : {},
    ...(template ? { template } : {}),
    meta: {
      title:
        reader.text(meta.title, "meta.title", 200, false)
        ?? slides.find((slide) => slide.title)?.title
        ?? "Presentation",
      author: reader.text(meta.author, "meta.author", 120, false) ?? "Umbratic",
    },
    slides,
  };
  return reader.errors.length > 0 ? { errors: reader.errors } : { spec, errors: [] };
}

function readTemplate(reader: SpecReader, value: unknown): TemplateSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    reader.fail("template", "must be an object with a path");
    return undefined;
  }
  const path = reader.text(value.path, "template.path", 400, true);
  if (!path) return undefined;
  const mode = value.mode === undefined ? "reuse" : value.mode;
  if (mode !== "reuse" && mode !== "style") {
    reader.fail("template.mode", 'must be "reuse" or "style"');
    return undefined;
  }
  const keepSlides: Array<number | "last"> = [];
  if (value.keepSlides !== undefined) {
    if (!Array.isArray(value.keepSlides)) {
      reader.fail("template.keepSlides", 'must be an array of slide numbers or "last"');
    } else {
      value.keepSlides.forEach((entry, index) => {
        if (entry === "last") keepSlides.push("last");
        else if (typeof entry === "number" && Number.isInteger(entry) && entry >= 1) keepSlides.push(entry);
        else reader.fail(`template.keepSlides[${index}]`, 'must be a slide number or "last"');
      });
    }
  }
  return { path, mode, keepSlides };
}

function readSlide(reader: SpecReader, value: unknown, path: string): SlideSpec {
  if (!isRecord(value)) {
    reader.fail(path, "must be an object");
    return { layout: "bullets" };
  }
  const layout = value.layout;
  if (typeof layout !== "string" || !(layoutNames as readonly string[]).includes(layout)) {
    reader.fail(`${path}.layout`, `must be one of ${layoutNames.join(", ")}`);
    return { layout: "bullets" };
  }
  const slide: SlideSpec = { layout: layout as SlideLayoutName };
  const title = reader.text(
    value.title,
    `${path}.title`,
    limits.titleCharacters,
    layout !== "quote" && layout !== "image",
  );
  if (title) slide.title = title;
  const notes = reader.text(value.notes, `${path}.notes`, limits.notesCharacters, false);
  if (notes) slide.notes = notes;

  switch (layout) {
    case "title":
    case "closing": {
      const subtitle = reader.text(value.subtitle, `${path}.subtitle`, 160, false);
      if (subtitle) slide.subtitle = subtitle;
      break;
    }
    case "section":
      break;
    case "bullets": {
      slide.bullets = readBullets(reader, value.bullets, `${path}.bullets`, true);
      break;
    }
    case "two-column": {
      slide.left = readColumn(reader, value.left, `${path}.left`);
      slide.right = readColumn(reader, value.right, `${path}.right`);
      break;
    }
    case "image": {
      const image = reader.text(value.image, `${path}.image`, 400, true);
      if (image) slide.image = image;
      const caption = reader.text(value.caption, `${path}.caption`, 200, false);
      if (caption) slide.caption = caption;
      const alt = reader.text(value.alt, `${path}.alt`, 300, false);
      if (alt) slide.alt = alt;
      break;
    }
    case "chart": {
      const chart = readChart(reader, value.chart, `${path}.chart`);
      if (chart) slide.chart = chart;
      break;
    }
    case "table": {
      readTable(reader, value, path, slide);
      break;
    }
    case "kpis": {
      slide.items = readKpis(reader, value.items, `${path}.items`);
      break;
    }
    case "quote": {
      const quote = reader.text(value.quote, `${path}.quote`, 400, true);
      if (quote) slide.quote = quote;
      const attribution = reader.text(value.attribution, `${path}.attribution`, 160, false);
      if (attribution) slide.attribution = attribution;
      break;
    }
  }
  return slide;
}

function readBullets(
  reader: SpecReader,
  value: unknown,
  path: string,
  required: boolean,
): BulletItem[] {
  if (value === undefined || value === null) {
    if (required) reader.fail(path, "is required");
    return [];
  }
  if (!Array.isArray(value)) {
    reader.fail(path, "must be an array of strings or {text, level} objects");
    return [];
  }
  if (value.length > limits.bulletsPerSlide) {
    reader.fail(
      path,
      `has ${value.length} items; max ${limits.bulletsPerSlide} — split the slide`,
    );
    return [];
  }
  const bullets: BulletItem[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof entry === "string") {
      const text = reader.text(entry, itemPath, limits.bulletCharacters, true);
      if (text) bullets.push({ text, level: 0 });
      return;
    }
    if (!isRecord(entry)) {
      reader.fail(itemPath, "must be a string or a {text, level} object");
      return;
    }
    const level = entry.level === undefined ? 0 : entry.level;
    if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level >= limits.bulletLevels) {
      reader.fail(`${itemPath}.level`, `must be an integer from 0 to ${limits.bulletLevels - 1}`);
      return;
    }
    // A sub-bullet is indented and therefore narrower, so it gets less room
    // rather than the same allowance as a top-level one.
    const allowance = level === 0 ? limits.bulletCharacters : limits.bulletCharacters + 30;
    const text = reader.text(entry.text, `${itemPath}.text`, allowance, true);
    if (text) bullets.push({ text, level });
  });
  if (bullets.length > 0 && bullets[0]!.level !== 0) {
    reader.fail(`${path}[0].level`, "the first bullet cannot be a sub-bullet");
  }
  return bullets;
}

function readColumn(reader: SpecReader, value: unknown, path: string): ColumnContent {
  if (!isRecord(value)) {
    reader.fail(path, "must be an object with bullets, image, or text");
    return {};
  }
  const column: ColumnContent = {};
  if (value.bullets !== undefined) {
    column.bullets = readBullets(reader, value.bullets, `${path}.bullets`, false);
  }
  if (value.image !== undefined) {
    const image = reader.text(value.image, `${path}.image`, 400, false);
    if (image) column.image = image;
  }
  if (value.text !== undefined) {
    const text = reader.text(value.text, `${path}.text`, 600, false);
    if (text) column.text = text;
  }
  if (!column.bullets && !column.image && !column.text) {
    reader.fail(path, "must contain bullets, an image, or text");
  }
  if (column.image && (column.bullets || column.text)) {
    reader.fail(path, "must contain either an image or text, not both");
  }
  return column;
}

function readChart(reader: SpecReader, value: unknown, path: string): ChartSpec | undefined {
  if (!isRecord(value)) {
    reader.fail(path, "must be an object with type, categories, and series");
    return undefined;
  }
  const type = value.type;
  if (typeof type !== "string" || !(chartTypes as readonly string[]).includes(type)) {
    reader.fail(`${path}.type`, `must be one of ${chartTypes.join(", ")}`);
    return undefined;
  }
  const categories: string[] = [];
  if (!Array.isArray(value.categories) || value.categories.length === 0) {
    reader.fail(`${path}.categories`, "must be a non-empty array of labels");
    return undefined;
  }
  if (value.categories.length > limits.chartCategories) {
    reader.fail(
      `${path}.categories`,
      `has ${value.categories.length} entries; max ${limits.chartCategories}`,
    );
    return undefined;
  }
  value.categories.forEach((entry, index) => {
    const label = reader.text(entry, `${path}.categories[${index}]`, 60, true);
    if (label) categories.push(label);
  });
  if (type === "pie" && categories.length > limits.pieSlices) {
    reader.fail(
      `${path}.categories`,
      `has ${categories.length} slices; max ${limits.pieSlices} on a pie — group the tail into "Other"`,
    );
  }
  if (!Array.isArray(value.series) || value.series.length === 0) {
    reader.fail(`${path}.series`, "must be a non-empty array of {name, values}");
    return undefined;
  }
  if (value.series.length > limits.chartSeries) {
    reader.fail(`${path}.series`, `has ${value.series.length} series; max ${limits.chartSeries}`);
    return undefined;
  }
  if (type === "pie" && value.series.length > 1) {
    reader.fail(`${path}.series`, "a pie chart shows exactly one series");
    return undefined;
  }
  const series: ChartSpec["series"] = [];
  value.series.forEach((entry, index) => {
    const seriesPath = `${path}.series[${index}]`;
    if (!isRecord(entry)) {
      reader.fail(seriesPath, "must be a {name, values} object");
      return;
    }
    const name = reader.text(entry.name, `${seriesPath}.name`, 60, true);
    if (!Array.isArray(entry.values)) {
      reader.fail(`${seriesPath}.values`, "must be an array of numbers");
      return;
    }
    // A series shorter or longer than the category axis is the mismatch that
    // makes a chart render with a blank tail, so it is refused at the spec
    // rather than reported after the file is built.
    if (entry.values.length !== categories.length) {
      reader.fail(
        `${seriesPath}.values`,
        `has ${entry.values.length} values but there are ${categories.length} categories`,
      );
      return;
    }
    const values: number[] = [];
    entry.values.forEach((raw, valueIndex) => {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        reader.fail(`${seriesPath}.values[${valueIndex}]`, "must be a finite number");
        return;
      }
      values.push(raw);
    });
    if (name && values.length === entry.values.length) series.push({ name, values });
  });
  if (series.length === 0) return undefined;
  return { type: type as ChartType, categories, series };
}

function readTable(reader: SpecReader, value: Record<string, unknown>, path: string, slide: SlideSpec): void {
  if (!Array.isArray(value.columns) || value.columns.length === 0) {
    reader.fail(`${path}.columns`, "must be a non-empty array of header labels");
    return;
  }
  if (value.columns.length > limits.tableColumns) {
    reader.fail(
      `${path}.columns`,
      `has ${value.columns.length} columns; max ${limits.tableColumns} — drop a column or use two slides`,
    );
    return;
  }
  const columns: string[] = [];
  value.columns.forEach((entry, index) => {
    const label = reader.text(entry, `${path}.columns[${index}]`, 60, true);
    if (label) columns.push(label);
  });
  if (!Array.isArray(value.rows)) {
    reader.fail(`${path}.rows`, "must be an array of row arrays");
    return;
  }
  // The header occupies one of the twelve, so the body gets one less.
  if (value.rows.length > limits.tableRows - 1) {
    reader.fail(
      `${path}.rows`,
      `has ${value.rows.length} rows; max ${limits.tableRows - 1} below the header`,
    );
    return;
  }
  const rows: string[][] = [];
  value.rows.forEach((row, rowIndex) => {
    const rowPath = `${path}.rows[${rowIndex}]`;
    if (!Array.isArray(row)) {
      reader.fail(rowPath, "must be an array of cell strings");
      return;
    }
    if (row.length !== columns.length) {
      reader.fail(rowPath, `has ${row.length} cells but there are ${columns.length} columns`);
      return;
    }
    const cells: string[] = [];
    row.forEach((cell, cellIndex) => {
      if (cell === null || cell === undefined) {
        cells.push("");
        return;
      }
      if (typeof cell === "number" || typeof cell === "boolean") {
        cells.push(String(cell));
        return;
      }
      const text = reader.text(cell, `${rowPath}[${cellIndex}]`, 120, false);
      cells.push(text ?? "");
    });
    rows.push(cells);
  });
  slide.columns = columns;
  slide.rows = rows;
}

function readKpis(
  reader: SpecReader,
  value: unknown,
  path: string,
): Array<{ label: string; value: string; delta?: string }> {
  if (!Array.isArray(value)) {
    reader.fail(path, "must be an array of {label, value, delta} objects");
    return [];
  }
  if (value.length < limits.kpisMin || value.length > limits.kpisMax) {
    reader.fail(
      path,
      `has ${value.length} items; this layout takes ${limits.kpisMin} to ${limits.kpisMax}`,
    );
    return [];
  }
  const items: Array<{ label: string; value: string; delta?: string }> = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      reader.fail(itemPath, "must be a {label, value, delta} object");
      return;
    }
    const label = reader.text(entry.label, `${itemPath}.label`, 40, true);
    const figure = reader.text(entry.value, `${itemPath}.value`, 20, true);
    const delta = reader.text(entry.delta, `${itemPath}.delta`, 20, false);
    if (label && figure) items.push({ label, value: figure, ...(delta ? { delta } : {}) });
  });
  return items;
}
