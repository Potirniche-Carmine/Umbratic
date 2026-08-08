export type ComposerAttachmentReference = {
  path: string;
  name: string;
  kind?: "file" | "folder";
};

export type PromptHighlightSegment = {
  text: string;
  mention: boolean;
};

export type MatchHighlightSegment = {
  text: string;
  hit: boolean;
};

export type SkillSearchCandidate = {
  id: string;
  name: string;
  description: string;
};

export type NumberedListContinuation = {
  value: string;
  caret: number;
};

export type ComposerTextInsertion = {
  value: string;
  caret: number;
};

export type MarkdownBlock =
  | { type: "code"; language: string; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

export function attachmentName(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).pop() ?? pathValue;
}

export function attachmentLabel(file: ComposerAttachmentReference): string {
  return file.name || attachmentName(file.path);
}

export function attachmentMention(file: ComposerAttachmentReference): string {
  const label = attachmentLabel(file);
  return file.kind === "folder" ? `@${label}/` : `@${label}`;
}

/// Marks where the query matched, so the picker can show *why* each row is in
/// the list instead of leaving the user to guess.
export function matchHighlightSegments(text: string, query: string): MatchHighlightSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return [{ text, hit: false }];
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return [{ text, hit: false }];
  const segments: MatchHighlightSegment[] = [];
  if (index > 0) segments.push({ text: text.slice(0, index), hit: false });
  segments.push({ text: text.slice(index, index + needle.length), hit: true });
  if (index + needle.length < text.length) segments.push({ text: text.slice(index + needle.length), hit: false });
  return segments;
}

/// Prefix matches on the skill's name or id come first, then substring
/// matches, then description hits — mirroring how the file search ranks.
export function rankSkillMatches<T extends SkillSearchCandidate>(
  skills: readonly T[],
  query: string,
  limit = 10,
): T[] {
  const needle = query.trim().toLowerCase();
  const tier = (skill: SkillSearchCandidate): number => {
    if (!needle) return 0;
    const id = skill.id.toLowerCase();
    const name = skill.name.toLowerCase();
    if (name.startsWith(needle) || id.startsWith(needle)) return 0;
    if (name.includes(needle) || id.includes(needle)) return 1;
    if (skill.description.toLowerCase().includes(needle)) return 2;
    return 3;
  };
  return skills
    .map((skill, index) => ({ skill, index, tier: tier(skill) }))
    .filter((entry) => entry.tier < 3)
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.skill);
}

export function withoutTrailingEmptyLines(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/(?:\n[ \t]*)+$/, "");
}

export function insertPastedComposerText(
  value: string,
  pastedText: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ComposerTextInsertion {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const insertion = withoutTrailingEmptyLines(pastedText);
  return {
    value: `${value.slice(0, start)}${insertion}${value.slice(end)}`,
    caret: start + insertion.length,
  };
}

export function composerPromptForSend(value: string): string {
  return withoutTrailingEmptyLines(value).trim();
}

export function continueNumberedList(
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): NumberedListContinuation | null {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineBeforeCaret = value.slice(lineStart, start);
  const match = lineBeforeCaret.match(/^(\s*)(\d+)([.)])(?:[ \t]+|$)/);
  if (!match) return null;

  const currentNumber = Number(match[2]);
  if (!Number.isSafeInteger(currentNumber) || currentNumber >= Number.MAX_SAFE_INTEGER) return null;

  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
  const itemBeforeCaret = lineBeforeCaret.slice(match[0].length);
  const itemAfterSelection = value.slice(end, lineEnd);
  if (currentNumber > 1 && !itemBeforeCaret.trim() && !itemAfterSelection.trim()) {
    return {
      value: `${value.slice(0, lineStart)}${value.slice(lineEnd)}`,
      caret: lineStart,
    };
  }

  const nextNumber = String(currentNumber + 1).padStart(match[2].length, "0");
  const insertion = `\n${match[1]}${nextNumber}${match[3]} `;
  return {
    value: `${value.slice(0, start)}${insertion}${value.slice(end)}`,
    caret: start + insertion.length,
  };
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

const markdownListItem = /^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/;

/// Reports whether the next non-blank line continues a list of the same kind.
function continuesList(lines: string[], from: number, ordered: boolean): boolean {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const item = line.match(markdownListItem);
    return !!item && !!item[2] === ordered;
  }
  return false;
}

/// Common inline LaTeX, rendered as the symbol a reader expects.
///
/// Models reach for `$\rightarrow$` in architecture descriptions. Without this
/// the delimiters and command leak into the message as literal text.
const mathSymbols: Record<string, string> = {
  rightarrow: "→", to: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  times: "×", cdot: "·", div: "÷", pm: "±", neq: "≠",
  leq: "≤", geq: "≥", approx: "≈", ldots: "…", dots: "…",
};

function renderInlineMath(text: string): string {
  return text.replace(/\$\$?([^$\n]+?)\$\$?/g, (whole, expression: string) => {
    const rendered = expression
      .replace(/\\([A-Za-z]+)/g, (command, name: string) => mathSymbols[name] ?? command)
      // Escaped literals carry no meaning outside LaTeX.
      .replace(/\\([%$&_#{}])/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Anything still carrying a backslash is real LaTeX this renderer cannot
    // display; leaving it verbatim beats showing a mangled half-translation.
    return rendered.includes("\\") ? whole : rendered;
  });
}

function withRenderedMath(block: MarkdownBlock): MarkdownBlock {
  switch (block.type) {
    case "code":
      return block;
    case "heading":
      return { ...block, text: renderInlineMath(block.text) };
    case "paragraph":
      return { ...block, text: renderInlineMath(block.text) };
    case "list":
      return { ...block, items: block.items.map(renderInlineMath) };
    case "table":
      return {
        ...block,
        headers: block.headers.map(renderInlineMath),
        rows: block.rows.map((row) => row.map(renderInlineMath)),
      };
  }
}

export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listOrdered = false;
  let code: { language: string; lines: string[]; indent: string } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", ordered: listOrdered, items: list });
      list = [];
      listOrdered = false;
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
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const listItem = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/);
    if (listItem) {
      const ordered = !!listItem[2];
      flushParagraph();
      if (list.length && listOrdered !== ordered) flushList();
      listOrdered = ordered;
      list.push(listItem[3]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      // A blank line between items is a loose list, not two lists. Flushing here
      // started a second <ol>, which restarts numbering at 1, so a model that
      // spaces out its steps rendered "1. 1. 1." instead of "1. 2. 3.".
      if (!list.length || !continuesList(lines, lineIndex + 1, listOrdered)) flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code) blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
  flushParagraph();
  flushList();
  return blocks.map(withRenderedMath);
}

// Streaming text ends mid-construct constantly. Rendering the tail with the
// normal inline rules would leave "**bol" as literal asterisks and then snap it
// to bold when the closer arrives; stabilizing first means styling appears
// progressively instead of popping. Two moves: a bare marker at the very end
// (an opener the model is still typing) is held back from display, and a
// marker that already opened styled content is closed at the end of the text.
export function stabilizeStreamingInlineText(text: string): string {
  const closers: string[] = [];
  let openCode: string | null = null;
  let holdBackFrom: number | null = null;
  const drop = (marker: string) => {
    const index = closers.lastIndexOf(marker);
    if (index >= 0) closers.splice(index, 1);
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && /[`*_\\]/.test(text[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if (char === "`") {
      let endOfRun = index;
      while (endOfRun < text.length && text[endOfRun] === "`") endOfRun += 1;
      const run = text.slice(index, endOfRun);
      if (openCode === run) {
        openCode = null;
        drop(run);
      } else if (!openCode) {
        if (endOfRun === text.length) {
          holdBackFrom = index;
          break;
        }
        openCode = run;
        closers.push(run);
      }
      index = endOfRun - 1;
      continue;
    }
    if (openCode) continue;
    if (char !== "*" && char !== "_") {
      // Emphasis never spans a line break, so an open single marker lapses.
      if (char === "\n") {
        drop("*");
        drop("_");
      }
      continue;
    }
    const marker = text.startsWith("**", index) ? "**" : char;
    const before = text[index - 1];
    const after = text[index + marker.length];
    const open = closers.includes(marker);
    if (open && before !== undefined && !/\s/.test(before)) {
      drop(marker);
    } else if (!open && (before === undefined || /\s/.test(before))) {
      // Only a word-leading marker counts as an opener: an intra-word "*" or
      // "_" (snake_case, 5 * 3) may never see a closer, and styling it during
      // the stream would pop back to literal text on the final render.
      if (after === undefined) {
        holdBackFrom = index;
        break;
      }
      if (!/\s/.test(after)) closers.push(marker);
    }
    index += marker.length - 1;
  }
  const visible = holdBackFrom === null ? text : text.slice(0, holdBackFrom);
  return `${visible}${closers.reverse().join("")}`;
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

/// Whether the markdown character at `index` was escaped with a backslash.
/// Counting the run matters: `\\*` is an escaped backslash followed by live
/// emphasis, not an escaped asterisk.
export function isEscapedMarkdownAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
