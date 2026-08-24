/**
 * The block vocabulary DOCX and PDF share.
 *
 * One spec, two renderers. A model that has learned to describe a document once
 * can ask for it as either format, and `inspect docx` → `create pdf` is a
 * re-typeset rather than a conversion — the blocks survive, the page geometry is
 * decided again by whichever renderer is running.
 *
 * Presets own typography entirely. The spec names a preset and content; it never
 * names a point size, a margin, or a colour, which is what keeps a generated
 * document from reading like a generated document.
 */

export type SpecError = { path: string; message: string };

export const limits = {
  blocks: 400,
  titleCharacters: 200,
  headingCharacters: 200,
  paragraphCharacters: 8_000,
  listItems: 60,
  listItemCharacters: 1_000,
  calloutCharacters: 600,
  tableColumns: 10,
  tableRows: 200,
  cellCharacters: 500,
  captionCharacters: 300,
  quoteCharacters: 1_500,
  formFields: 40,
  chartSeries: 6,
  chartCategories: 24,
} as const;

export const presetNames = [
  "standard_business_brief",
  "compact_reference_guide",
  "narrative_proposal",
  "simple_word_default",
  "form_or_questionnaire",
] as const;
export type PresetName = (typeof presetNames)[number];

export const calloutStyles = ["note", "warning", "decision", "summary"] as const;
export type CalloutStyle = (typeof calloutStyles)[number];

export const formFieldKinds = ["text", "checkbox", "choice"] as const;
export type FormFieldKind = (typeof formFieldKinds)[number];

export type Alignment = "left" | "center" | "right";

export type TableColumn = { header: string; width?: number; align: Alignment };

export type Block =
  | { type: "title"; text: string; subtitle?: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbered"; items: string[] }
  | { type: "checklist"; items: string[] }
  | { type: "definitions"; items: Array<{ term: string; definition: string }> }
  | { type: "callout"; style: CalloutStyle; title?: string; text: string }
  | { type: "table"; columns: TableColumn[]; rows: string[][]; caption?: string }
  | { type: "image"; path: string; width: number; caption?: string; alt?: string }
  | {
      type: "chart";
      chart: { type: string; categories: string[]; series: Array<{ name: string; values: number[] }> };
      caption?: string;
    }
  | { type: "quote"; text: string; attribution?: string }
  | { type: "pageBreak" }
  | { type: "signature"; fields: string[] }
  | { type: "formField"; label: string; kind: FormFieldKind; choices?: string[] };

export type DocumentSpec = {
  format: "docx" | "pdf";
  preset: PresetName;
  page: { size: "Letter" | "A4"; orientation: "portrait" | "landscape" };
  meta: { title: string; author: string; subject?: string };
  header?: { text: string };
  footer?: { text?: string; pageNumbers: boolean };
  toc: boolean;
  blocks: Block[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Reader {
  readonly errors: SpecError[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  text(value: unknown, path: string, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(path, "is required");
      return undefined;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
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
      this.fail(path, `is ${trimmed.length} characters; max ${max} — shorten or split it`);
      return undefined;
    }
    return trimmed;
  }

  list(value: unknown, path: string, max: number, itemMax: number): string[] {
    if (!Array.isArray(value)) {
      this.fail(path, "must be an array of strings");
      return [];
    }
    if (value.length === 0) {
      this.fail(path, "must contain at least one item");
      return [];
    }
    if (value.length > max) {
      this.fail(path, `has ${value.length} items; max ${max}`);
      return [];
    }
    const items: string[] = [];
    value.forEach((entry, index) => {
      const item = this.text(entry, `${path}[${index}]`, itemMax, true);
      if (item) items.push(item);
    });
    return items;
  }
}

export function readDocumentSpec(
  input: unknown,
  format: "docx" | "pdf",
): { spec?: DocumentSpec; errors: SpecError[] } {
  const reader = new Reader();
  if (!isRecord(input)) return { errors: [{ path: "spec", message: "must be an object" }] };

  const blocksValue = input.blocks;
  if (!Array.isArray(blocksValue)) {
    reader.fail("blocks", "must be an array of block objects");
    return { errors: reader.errors };
  }
  if (blocksValue.length === 0) {
    reader.fail("blocks", "must contain at least one block");
    return { errors: reader.errors };
  }
  if (blocksValue.length > limits.blocks) {
    reader.fail("blocks", `has ${blocksValue.length} blocks; max ${limits.blocks}`);
    return { errors: reader.errors };
  }

  const blocks = blocksValue
    .map((block, index) => readBlock(reader, block, `blocks[${index}]`))
    .filter((block): block is Block => block !== undefined);

  // Exactly one title, and it goes first. Two titles is the shape a model
  // produces when it treats "title" as "big text", and the result reads as two
  // documents stapled together.
  const titles = blocks.filter((block) => block.type === "title");
  if (titles.length > 1) {
    reader.fail(
      `blocks[${blocks.indexOf(titles[1]!)}]`,
      "a document has one title; use a heading for the others",
    );
  }

  const preset = input.preset;
  if (preset !== undefined && !(presetNames as readonly unknown[]).includes(preset)) {
    reader.fail("preset", `must be one of ${presetNames.join(", ")}`);
  }
  const page = isRecord(input.page) ? input.page : {};
  if (page.size !== undefined && page.size !== "Letter" && page.size !== "A4") {
    reader.fail("page.size", 'must be "Letter" or "A4"');
  }
  if (
    page.orientation !== undefined
    && page.orientation !== "portrait"
    && page.orientation !== "landscape"
  ) {
    reader.fail("page.orientation", 'must be "portrait" or "landscape"');
  }

  const meta = isRecord(input.meta) ? input.meta : {};
  const header = isRecord(input.header) ? input.header : undefined;
  const footer = isRecord(input.footer) ? input.footer : undefined;
  const toc = input.toc === true;
  if (toc && !blocks.some((block) => block.type === "heading")) {
    reader.fail("toc", "was asked for but the document has no headings to list");
  }

  const spec: DocumentSpec = {
    format,
    preset: (preset as PresetName) ?? "standard_business_brief",
    page: {
      size: (page.size as "Letter" | "A4") ?? "Letter",
      orientation: (page.orientation as "portrait" | "landscape") ?? "portrait",
    },
    meta: {
      title:
        reader.text(meta.title, "meta.title", limits.titleCharacters, false)
        ?? titles[0]?.text
        ?? "Document",
      author: reader.text(meta.author, "meta.author", 120, false) ?? "Umbratic",
      ...(meta.subject !== undefined
        ? { subject: reader.text(meta.subject, "meta.subject", 300, false) ?? "" }
        : {}),
    },
    ...(header ? { header: { text: reader.text(header.text, "header.text", 200, true) ?? "" } } : {}),
    ...(footer
      ? {
          footer: {
            ...(footer.text !== undefined
              ? { text: reader.text(footer.text, "footer.text", 200, false) ?? "" }
              : {}),
            pageNumbers: footer.pageNumbers !== false,
          },
        }
      : {}),
    toc,
    blocks,
  };
  return reader.errors.length > 0 ? { errors: reader.errors } : { spec, errors: [] };
}

function readBlock(reader: Reader, value: unknown, path: string): Block | undefined {
  if (!isRecord(value)) {
    reader.fail(path, "must be an object with a type field");
    return undefined;
  }
  const type = value.type;
  switch (type) {
    case "title": {
      const text = reader.text(value.text, `${path}.text`, limits.titleCharacters, true);
      if (!text) return undefined;
      const subtitle = reader.text(value.subtitle, `${path}.subtitle`, limits.titleCharacters, false);
      return { type: "title", text, ...(subtitle ? { subtitle } : {}) };
    }
    case "heading": {
      const level = value.level ?? 1;
      if (level !== 1 && level !== 2 && level !== 3) {
        reader.fail(`${path}.level`, "must be 1, 2, or 3");
        return undefined;
      }
      const text = reader.text(value.text, `${path}.text`, limits.headingCharacters, true);
      return text ? { type: "heading", level, text } : undefined;
    }
    case "paragraph": {
      const text = reader.text(value.text, `${path}.text`, limits.paragraphCharacters, true);
      return text ? { type: "paragraph", text } : undefined;
    }
    case "bullets":
    case "numbered":
    case "checklist": {
      const items = reader.list(value.items, `${path}.items`, limits.listItems, limits.listItemCharacters);
      return items.length > 0 ? { type, items } : undefined;
    }
    case "definitions": {
      if (!Array.isArray(value.items) || value.items.length === 0) {
        reader.fail(`${path}.items`, "must be a non-empty array of {term, definition}");
        return undefined;
      }
      const items: Array<{ term: string; definition: string }> = [];
      value.items.forEach((entry, index) => {
        const itemPath = `${path}.items[${index}]`;
        if (!isRecord(entry)) {
          reader.fail(itemPath, "must be a {term, definition} object");
          return;
        }
        const term = reader.text(entry.term, `${itemPath}.term`, 200, true);
        const definition = reader.text(entry.definition, `${itemPath}.definition`, limits.listItemCharacters, true);
        if (term && definition) items.push({ term, definition });
      });
      return items.length > 0 ? { type: "definitions", items } : undefined;
    }
    case "callout": {
      const style = value.style ?? "note";
      if (!(calloutStyles as readonly unknown[]).includes(style)) {
        reader.fail(`${path}.style`, `must be one of ${calloutStyles.join(", ")}`);
        return undefined;
      }
      const text = reader.text(value.text, `${path}.text`, limits.calloutCharacters, true);
      if (!text) return undefined;
      const title = reader.text(value.title, `${path}.title`, 200, false);
      return { type: "callout", style: style as CalloutStyle, text, ...(title ? { title } : {}) };
    }
    case "table":
      return readTable(reader, value, path);
    case "image": {
      const imagePath = reader.text(value.path, `${path}.path`, 400, true);
      if (!imagePath) return undefined;
      const width = readPercentage(reader, value.width, `${path}.width`) ?? 100;
      const caption = reader.text(value.caption, `${path}.caption`, limits.captionCharacters, false);
      const alt = reader.text(value.alt, `${path}.alt`, limits.captionCharacters, false);
      return {
        type: "image",
        path: imagePath,
        width,
        ...(caption ? { caption } : {}),
        ...(alt ? { alt } : {}),
      };
    }
    case "chart":
      return readChart(reader, value, path);
    case "quote": {
      const text = reader.text(value.text, `${path}.text`, limits.quoteCharacters, true);
      if (!text) return undefined;
      const attribution = reader.text(value.attribution, `${path}.attribution`, 200, false);
      return { type: "quote", text, ...(attribution ? { attribution } : {}) };
    }
    case "pageBreak":
      return { type: "pageBreak" };
    case "signature": {
      const fields = reader.list(value.fields, `${path}.fields`, 8, 80);
      return fields.length > 0 ? { type: "signature", fields } : undefined;
    }
    case "formField": {
      const label = reader.text(value.label, `${path}.label`, 200, true);
      const kind = value.kind ?? "text";
      if (!(formFieldKinds as readonly unknown[]).includes(kind)) {
        reader.fail(`${path}.kind`, `must be one of ${formFieldKinds.join(", ")}`);
        return undefined;
      }
      if (!label) return undefined;
      if (kind === "choice") {
        const choices = reader.list(value.choices, `${path}.choices`, 20, 120);
        if (choices.length === 0) return undefined;
        return { type: "formField", label, kind: "choice", choices };
      }
      return { type: "formField", label, kind: kind as FormFieldKind };
    }
    default:
      reader.fail(
        `${path}.type`,
        `${String(type)} is not a block type; use title, heading, paragraph, bullets, numbered, checklist, definitions, callout, table, image, chart, quote, pageBreak, signature, or formField`,
      );
      return undefined;
  }
}

/** Widths arrive as "60%" or as a number. Either way they end up a percentage. */
function readPercentage(reader: Reader, value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw =
    typeof value === "string" ? Number(value.trim().replace(/%$/, "")) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
    reader.fail(path, 'must be a percentage from 1 to 100, such as "80%"');
    return undefined;
  }
  return raw;
}

function readTable(reader: Reader, value: Record<string, unknown>, path: string): Block | undefined {
  if (!Array.isArray(value.columns) || value.columns.length === 0) {
    reader.fail(`${path}.columns`, "must be a non-empty array of column definitions");
    return undefined;
  }
  if (value.columns.length > limits.tableColumns) {
    reader.fail(
      `${path}.columns`,
      `has ${value.columns.length} columns; max ${limits.tableColumns} — a wider table does not fit a page`,
    );
    return undefined;
  }
  const columns: TableColumn[] = [];
  value.columns.forEach((entry, index) => {
    const columnPath = `${path}.columns[${index}]`;
    if (typeof entry === "string") {
      columns.push({ header: entry, align: "left" });
      return;
    }
    if (!isRecord(entry)) {
      reader.fail(columnPath, "must be a header string or a {header, width, align} object");
      return;
    }
    const header = reader.text(entry.header, `${columnPath}.header`, 200, true);
    if (!header) return;
    const align = entry.align ?? "left";
    if (align !== "left" && align !== "center" && align !== "right") {
      reader.fail(`${columnPath}.align`, 'must be "left", "center", or "right"');
      return;
    }
    const width = readPercentage(reader, entry.width, `${columnPath}.width`);
    columns.push({ header, align, ...(width !== undefined ? { width } : {}) });
  });

  if (!Array.isArray(value.rows)) {
    reader.fail(`${path}.rows`, "must be an array of row arrays");
    return undefined;
  }
  if (value.rows.length > limits.tableRows) {
    reader.fail(`${path}.rows`, `has ${value.rows.length} rows; max ${limits.tableRows}`);
    return undefined;
  }
  const rows: string[][] = [];
  value.rows.forEach((row, rowIndex) => {
    const rowPath = `${path}.rows[${rowIndex}]`;
    if (!Array.isArray(row)) {
      reader.fail(rowPath, "must be an array of cell values");
      return;
    }
    if (row.length !== columns.length) {
      reader.fail(rowPath, `has ${row.length} cells but there are ${columns.length} columns`);
      return;
    }
    rows.push(
      row.map((cell, cellIndex) =>
        cell === null || cell === undefined
          ? ""
          : reader.text(cell, `${rowPath}[${cellIndex}]`, limits.cellCharacters, false) ?? "",
      ),
    );
  });

  // Declared widths that do not add up produce a table that either overflows
  // the text column or leaves a gap; both read as a rendering fault.
  const declared = columns.filter((column) => column.width !== undefined);
  if (declared.length === columns.length) {
    const total = declared.reduce((sum, column) => sum + (column.width ?? 0), 0);
    if (Math.abs(total - 100) > 1) {
      reader.fail(`${path}.columns`, `the declared widths add up to ${total}%, not 100%`);
    }
  }

  const caption = reader.text(value.caption, `${path}.caption`, limits.captionCharacters, false);
  return { type: "table", columns, rows, ...(caption ? { caption } : {}) };
}

function readChart(reader: Reader, value: Record<string, unknown>, path: string): Block | undefined {
  const chart = value.chart;
  if (!isRecord(chart)) {
    reader.fail(`${path}.chart`, "must be an object with type, categories, and series");
    return undefined;
  }
  const type = chart.type;
  if (typeof type !== "string" || !["bar", "column", "line", "pie"].includes(type)) {
    reader.fail(`${path}.chart.type`, "must be one of bar, column, line, pie");
    return undefined;
  }
  const categories = reader.list(chart.categories, `${path}.chart.categories`, limits.chartCategories, 60);
  if (categories.length === 0) return undefined;
  if (!Array.isArray(chart.series) || chart.series.length === 0) {
    reader.fail(`${path}.chart.series`, "must be a non-empty array of {name, values}");
    return undefined;
  }
  if (chart.series.length > limits.chartSeries) {
    reader.fail(`${path}.chart.series`, `has ${chart.series.length} series; max ${limits.chartSeries}`);
    return undefined;
  }
  const series: Array<{ name: string; values: number[] }> = [];
  chart.series.forEach((entry, index) => {
    const seriesPath = `${path}.chart.series[${index}]`;
    if (!isRecord(entry)) {
      reader.fail(seriesPath, "must be a {name, values} object");
      return;
    }
    const name = reader.text(entry.name, `${seriesPath}.name`, 60, true);
    if (!Array.isArray(entry.values)) {
      reader.fail(`${seriesPath}.values`, "must be an array of numbers");
      return;
    }
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
  const caption = reader.text(value.caption, `${path}.caption`, limits.captionCharacters, false);
  return {
    type: "chart",
    chart: { type, categories, series },
    ...(caption ? { caption } : {}),
  };
}
