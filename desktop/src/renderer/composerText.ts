export type ComposerAttachmentReference = {
  path: string;
  name: string;
};

export type PromptHighlightSegment = {
  text: string;
  mention: boolean;
};

export type MarkdownBlock =
  | { type: "code"; language: string; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

export function attachmentName(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).pop() ?? pathValue;
}

export function attachmentLabel(file: ComposerAttachmentReference): string {
  return file.name || attachmentName(file.path);
}

export function attachmentMention(file: ComposerAttachmentReference): string {
  return `@${attachmentLabel(file)}`;
}

export function promptHighlightSegments(value: string, files: ComposerAttachmentReference[]): PromptHighlightSegment[] {
  const tokens = files
    .map((file) => attachmentMention(file))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!tokens.length) return [{ text: value || "\u200b", mention: false }];
  const segments: PromptHighlightSegment[] = [];
  let index = 0;
  while (index < value.length) {
    const token = tokens.find(
      (candidate) =>
        value.startsWith(candidate, index) &&
        (index === 0 || /\s/.test(value[index - 1])) &&
        (index + candidate.length === value.length || /\s|[.,;:!?)]/.test(value[index + candidate.length])),
    );
    if (token) {
      segments.push({ text: token, mention: true });
      index += token.length;
      continue;
    }
    const nextMention = tokens
      .map((candidate) => value.indexOf(candidate, index + 1))
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    const end = nextMention ?? value.length;
    segments.push({ text: value.slice(index, end), mention: false });
    index = end;
  }
  if (value.endsWith("\n")) segments.push({ text: "\u200b", mention: false });
  return segments;
}

export function splitMarkdownTableRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const escaped = index > 0 && source[index - 1] === "\\";
    if (char === "`" && !escaped) inCode = !inCode;
    if (char === "|" && !inCode && !escaped) {
      cells.push(cell.replace(/\\\|/g, "|").trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.replace(/\\\|/g, "|").trim());
  return cells;
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && splitMarkdownTableRow(line).length > 1;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function normalizeMarkdownTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: { language: string; lines: string[]; indent: string } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^(\s*)```\s*([A-Za-z0-9_+.#-]+)?\s*$/);
    if (fence) {
      if (code) {
        blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { language: fence[2] ?? "", lines: [], indent: fence[1] ?? "" };
      }
      continue;
    }
    if (code) {
      code.lines.push(code.indent && line.startsWith(code.indent) ? line.slice(code.indent.length) : line);
      continue;
    }
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[lineIndex + 1] ?? "")) {
      flushParagraph();
      flushList();

      const headers = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      let rowIndex = lineIndex + 2;
      while (rowIndex < lines.length && isMarkdownTableRow(lines[rowIndex]) && !isMarkdownTableSeparator(lines[rowIndex])) {
        rows.push(normalizeMarkdownTableRow(splitMarkdownTableRow(lines[rowIndex]), headers.length));
        rowIndex += 1;
      }
      blocks.push({ type: "table", headers, rows });
      lineIndex = rowIndex - 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code) blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

export function markdownPreview(content: string, limit = 60000): { text: string; truncated: boolean } {
  if (content.length <= limit) return { text: content, truncated: false };
  const paragraphBreak = content.lastIndexOf("\n\n", limit);
  const sentenceBreak = content.lastIndexOf(". ", limit);
  const cutoff =
    paragraphBreak > limit * 0.55
      ? paragraphBreak
      : sentenceBreak > limit * 0.55
        ? sentenceBreak + 1
        : limit;
  return { text: content.slice(0, cutoff).trimEnd(), truncated: true };
}
