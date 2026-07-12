export type DiffLineOrigin = "context" | "addition" | "deletion";
export type DiffSide = "old" | "new";

export type DiffLine = {
  origin: DiffLineOrigin;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

export function parseGitPorcelainPaths(output: string): string[] {
  const entries = output.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3).replace(/\\/g, "/");
    if (filePath) paths.add(filePath);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

export type ReviewFile = {
  path: string;
  oldPath?: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  /** Legacy alias retained while persisted task records migrate. */
  diff: string;
  contentHash: string;
  hunks: DiffHunk[];
  tooLarge?: boolean;
};

export type IntraLineSpan = { text: string; changed: boolean };

export type DiffCell = {
  side: DiffSide;
  line: number | null;
  content: string;
  origin: DiffLineOrigin | "empty";
  spans?: IntraLineSpan[];
  hunkId?: string;
};

export type SideBySideRow = {
  id: string;
  kind: "context" | "modification" | "addition" | "deletion";
  left: DiffCell;
  right: DiffCell;
  hunkId: string;
};

const maxPatchCharacters = 4_000_000;
const maxSemanticBlockLines = 200;
const maxAlignmentCells = 40_000;
const maxIntraLineCharacters = 2_000;

export function stableReviewHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return trimmed;
  const withoutPrefix = trimmed.replace(/^[ab]\//, "");
  if (!withoutPrefix.startsWith('"') || !withoutPrefix.endsWith('"')) return withoutPrefix;
  try {
    return JSON.parse(withoutPrefix);
  } catch {
    return withoutPrefix.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function parseDiffGitPaths(line: string): { oldPath?: string; path?: string } {
  const match = line.match(/^diff --git ("(?:\\.|[^"])+"|\S+) ("(?:\\.|[^"])+"|\S+)$/);
  if (!match) return {};
  return { oldPath: unquoteGitPath(match[1]), path: unquoteGitPath(match[2]) };
}

function parseHunkHeader(line: string) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    suffix: match[5] ?? "",
  };
}

export function parseReviewPatch(patchInput: string, fallbackPath = "unknown"): ReviewFile {
  const originalPatch = typeof patchInput === "string" ? patchInput : "";
  const tooLarge = originalPatch.length > maxPatchCharacters;
  const patch = tooLarge ? originalPatch.slice(0, maxPatchCharacters) : originalPatch;
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  let path = fallbackPath;
  let oldPath: string | undefined;
  let status: ReviewFileStatus = "modified";
  let binary = false;
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitPaths(line);
      if (parsed.path) path = parsed.path;
      if (parsed.oldPath && parsed.oldPath !== parsed.path) oldPath = parsed.oldPath;
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = unquoteGitPath(line.slice(12));
      status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      path = unquoteGitPath(line.slice(10));
      status = "renamed";
      continue;
    }
    if (line.startsWith("copy from ")) {
      oldPath = unquoteGitPath(line.slice(10));
      status = "copied";
      continue;
    }
    if (line.startsWith("copy to ")) {
      path = unquoteGitPath(line.slice(8));
      status = "copied";
      continue;
    }
    if (line.startsWith("new file mode ") || line === "--- /dev/null") status = "added";
    if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") status = "deleted";
    if (/^(Binary files .* differ|GIT binary patch|Binary file )/.test(line)) binary = true;
    if (line.startsWith("--- ") && line !== "--- /dev/null") oldPath = unquoteGitPath(line.slice(4));
    if (line.startsWith("+++ ") && line !== "+++ /dev/null") path = unquoteGitPath(line.slice(4));

    const header = parseHunkHeader(line);
    if (header) {
      const hunk: DiffHunk = {
        id: "",
        header: line,
        oldStart: header.oldStart,
        oldCount: header.oldCount,
        newStart: header.newStart,
        newCount: header.newCount,
        lines: [],
      };
      hunks.push(hunk);
      current = hunk;
      oldLine = header.oldStart;
      newLine = header.newStart;
      continue;
    }
    if (!current || line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ origin: "addition", content: line.slice(1), oldLine: null, newLine });
      additions += 1;
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ origin: "deletion", content: line.slice(1), oldLine, newLine: null });
      deletions += 1;
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({ origin: "context", content: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  for (const hunk of hunks) {
    const suffix = hunk.header.replace(/^@@[^@]+@@/, "");
    hunk.id = `h-${stableReviewHash(`${path}\n${suffix}\n${hunk.lines.map((line) => `${line.origin[0]}${line.content}`).join("\n")}`)}`;
  }
  if (binary) status = status === "added" || status === "deleted" ? status : "binary";
  return {
    path,
    oldPath: oldPath && oldPath !== path ? oldPath : undefined,
    status,
    additions,
    deletions,
    binary,
    patch: originalPatch,
    diff: originalPatch,
    contentHash: stableReviewHash(originalPatch),
    hunks,
    tooLarge,
  };
}

export function normalizeReviewFile(value: Partial<ReviewFile> & { path: string; diff?: string; patch?: string }): ReviewFile {
  const patch = typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : "";
  const parsed = parseReviewPatch(patch, value.path);
  const metadataStatus = parsed.status === "renamed" || parsed.status === "copied" || parsed.status === "binary";
  return {
    ...parsed,
    path: value.path || parsed.path,
    oldPath: value.oldPath ?? parsed.oldPath,
    status: metadataStatus ? parsed.status : value.status ?? parsed.status,
    binary: value.binary ?? parsed.binary,
    patch,
    diff: patch,
    contentHash: value.contentHash || parsed.contentHash,
    additions: Number.isFinite(value.additions) ? Number(value.additions) : parsed.additions,
    deletions: Number.isFinite(value.deletions) ? Number(value.deletions) : parsed.deletions,
    hunks: Array.isArray(value.hunks) && value.hunks.length ? value.hunks : parsed.hunks,
  };
}

function normalizedSimilarityText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function lineSimilarity(left: string, right: string): number {
  const a = normalizedSimilarityText(left);
  const b = normalizedSimilarityText(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aPairs = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    aPairs.set(pair, (aPairs.get(pair) ?? 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = aPairs.get(pair) ?? 0;
    if (count > 0) {
      intersection += 1;
      aPairs.set(pair, count - 1);
    }
  }
  return (2 * intersection) / Math.max(1, a.length + b.length - 2);
}

function shouldShowIntraLineDiff(left: string, right: string): boolean {
  const longerLength = Math.max(left.trim().length, right.trim().length);
  const shorterLength = Math.min(left.trim().length, right.trim().length);
  if (!longerLength || shorterLength / longerLength < 0.5) return false;
  return lineSimilarity(left, right) >= 0.5;
}

function tokenize(value: string): string[] {
  return value.match(/\s+|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\w\s]/g) ?? (value ? [value] : []);
}

export function intraLineDiff(left: string, right: string): { left: IntraLineSpan[]; right: IntraLineSpan[] } | undefined {
  if (left.length > maxIntraLineCharacters || right.length > maxIntraLineCharacters) return undefined;
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.length * b.length > maxAlignmentCells) return undefined;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let row = a.length - 1; row >= 0; row -= 1) {
    for (let col = b.length - 1; col >= 0; col -= 1) {
      table[row][col] = a[row] === b[col] ? table[row + 1][col + 1] + 1 : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  const leftSpans: IntraLineSpan[] = [];
  const rightSpans: IntraLineSpan[] = [];
  const push = (target: IntraLineSpan[], text: string, changed: boolean) => {
    const previous = target[target.length - 1];
    if (previous?.changed === changed) previous.text += text;
    else target.push({ text, changed });
  };
  let row = 0;
  let col = 0;
  while (row < a.length || col < b.length) {
    if (row < a.length && col < b.length && a[row] === b[col]) {
      push(leftSpans, a[row], false);
      push(rightSpans, b[col], false);
      row += 1;
      col += 1;
    } else if (col < b.length && (row === a.length || table[row][col + 1] >= table[row + 1][col])) {
      push(rightSpans, b[col], true);
      col += 1;
    } else {
      push(leftSpans, a[row], true);
      row += 1;
    }
  }
  return { left: leftSpans, right: rightSpans };
}

type Pair = { left?: DiffLine; right?: DiffLine };

function alignReplacementBlock(deletions: DiffLine[], additions: DiffLine[]): Pair[] {
  if (!deletions.length) return additions.map((right) => ({ right }));
  if (!additions.length) return deletions.map((left) => ({ left }));
  // A single deletion followed by a single addition is an unambiguous
  // replacement even when the text has no similarity (for example, replacing
  // a blank line). Keep both sides on the same visual row.
  if (deletions.length === 1 && additions.length === 1) return [{ left: deletions[0], right: additions[0] }];
  if (deletions.length > maxSemanticBlockLines || additions.length > maxSemanticBlockLines || deletions.length * additions.length > maxAlignmentCells) {
    return Array.from({ length: Math.max(deletions.length, additions.length) }, (_, index) => ({ left: deletions[index], right: additions[index] }));
  }
  const rows = deletions.length;
  const cols = additions.length;
  const scores = Array.from({ length: rows + 1 }, () => new Float32Array(cols + 1));
  const gap = -0.42;
  for (let row = 1; row <= rows; row += 1) scores[row][0] = scores[row - 1][0] + gap;
  for (let col = 1; col <= cols; col += 1) scores[0][col] = scores[0][col - 1] + gap;
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      const similarity = lineSimilarity(deletions[row - 1].content, additions[col - 1].content);
      const pair = scores[row - 1][col - 1] + (similarity >= 0.36 ? similarity : -0.56);
      scores[row][col] = Math.max(pair, scores[row - 1][col] + gap, scores[row][col - 1] + gap);
    }
  }
  const pairs: Pair[] = [];
  let row = rows;
  let col = cols;
  while (row > 0 || col > 0) {
    const similarity = row > 0 && col > 0 ? lineSimilarity(deletions[row - 1].content, additions[col - 1].content) : 0;
    const pairScore = row > 0 && col > 0 ? scores[row - 1][col - 1] + (similarity >= 0.36 ? similarity : -0.56) : -Infinity;
    if (row > 0 && col > 0 && similarity >= 0.36 && Math.abs(scores[row][col] - pairScore) < 0.001) {
      pairs.push({ left: deletions[row - 1], right: additions[col - 1] });
      row -= 1;
      col -= 1;
    } else if (row > 0 && (col === 0 || scores[row - 1][col] >= scores[row][col - 1])) {
      pairs.push({ left: deletions[row - 1] });
      row -= 1;
    } else {
      pairs.push({ right: additions[col - 1] });
      col -= 1;
    }
  }
  return pairs.reverse();
}

function emptyCell(side: DiffSide): DiffCell {
  return { side, line: null, content: "", origin: "empty" };
}

export function alignHunk(hunk: DiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let index = 0;
  const appendPair = (pair: Pair) => {
    const spans = pair.left && pair.right && shouldShowIntraLineDiff(pair.left.content, pair.right.content)
      ? intraLineDiff(pair.left.content, pair.right.content)
      : undefined;
    const kind = pair.left && pair.right ? "modification" : pair.left ? "deletion" : "addition";
    rows.push({
      id: `${hunk.id}-${rows.length}`,
      kind,
      hunkId: hunk.id,
      left: pair.left ? { side: "old", line: pair.left.oldLine, content: pair.left.content, origin: pair.left.origin, spans: spans?.left, hunkId: hunk.id } : emptyCell("old"),
      right: pair.right ? { side: "new", line: pair.right.newLine, content: pair.right.content, origin: pair.right.origin, spans: spans?.right, hunkId: hunk.id } : emptyCell("new"),
    });
  };
  while (index < hunk.lines.length) {
    const line = hunk.lines[index];
    if (line.origin === "context") {
      rows.push({
        id: `${hunk.id}-${rows.length}`,
        kind: "context",
        hunkId: hunk.id,
        left: { side: "old", line: line.oldLine, content: line.content, origin: "context", hunkId: hunk.id },
        right: { side: "new", line: line.newLine, content: line.content, origin: "context", hunkId: hunk.id },
      });
      index += 1;
      continue;
    }
    // Structured review records are not guaranteed to preserve Git's usual
    // deletion-before-addition ordering. Treat the entire changed block as one
    // replacement so semantically matching lines still share a visual row.
    const changedLines: DiffLine[] = [];
    while (hunk.lines[index] && hunk.lines[index].origin !== "context") changedLines.push(hunk.lines[index++]);
    const deletions = changedLines.filter((candidate) => candidate.origin === "deletion");
    const additions = changedLines.filter((candidate) => candidate.origin === "addition");
    for (const pair of alignReplacementBlock(deletions, additions)) appendPair(pair);
  }
  return rows;
}

export function alignReviewFile(file: ReviewFile): SideBySideRow[] {
  return file.hunks.flatMap(alignHunk);
}

export function reviewPatchHash(files: ReviewFile[]): string {
  return stableReviewHash(files.map((file) => `${file.path}\0${file.contentHash}`).sort().join("\0"));
}
