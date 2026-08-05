import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../src/renderer/composerText.ts");

function loadTypeScriptModule(filePath) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      console,
      exports: module.exports,
      module,
      require,
    },
    { filename: filePath },
  );
  return module.exports;
}

const {
  attachmentMention,
  composerPromptForSend,
  continueNumberedList,
  insertPastedComposerText,
  markdownPreview,
  matchHighlightSegments,
  parseMarkdown,
  promptHighlightSegments,
  rankSkillMatches,
  splitMarkdownTableRow,
} = loadTypeScriptModule(modulePath);

const plain = (value) => JSON.parse(JSON.stringify(value));

const markdown = [
  "## Fixture Heading",
  "",
  "Intro `@main.tsx` and **bold** plus <safe>&raw",
  "",
  "- One item",
  "- Second item with `code`",
  "",
  "1. Ordered item",
  "2. Second ordered item",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| A\\|B | `x|y` |",
  "",
  "```ts",
  'const html = "<div>&</div>";',
  'const escaped = "A\\\\|B";',
  "```",
].join("\n");

test("markdown parser preserves headings, paragraphs, lists, tables, and code", () => {
  const blocks = parseMarkdown(markdown);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].type, "paragraph");
  assert.equal(blocks[2].type, "list");
  assert.deepEqual(plain(blocks[2].items), ["One item", "Second item with `code`"]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[3].type, "list");
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(plain(blocks[3].items), ["Ordered item", "Second ordered item"]);
  assert.equal(blocks[4].type, "table");
  assert.deepEqual(plain(blocks[4].headers), ["Name", "Value"]);
  assert.deepEqual(plain(blocks[4].rows[0]), ["A|B", "`x|y`"]);
  assert.equal(blocks[5].type, "code");
  assert.equal(blocks[5].language, "ts");
  assert.match(blocks[5].content, /<div>&<\/div>/);
  assert.match(blocks[5].content, /A\\\\\|B/);
});

test("markdown parser handles nested headings, escaped table cells, and unfinished fences", () => {
  const nestedHeadingBlocks = parseMarkdown("#### A. The Agent/Skill Layer\n\nContent");
  assert.equal(nestedHeadingBlocks[0].type, "heading");
  assert.equal(nestedHeadingBlocks[0].level, 4);
  assert.equal(nestedHeadingBlocks[0].text, "A. The Agent/Skill Layer");
  assert.deepEqual(plain(splitMarkdownTableRow("| one | two\\|three | `a|b` |")), ["one", "two|three", "`a|b`"]);

  const unfinishedFence = parseMarkdown('```bash\nnpm run build && echo "done"');
  assert.equal(unfinishedFence.length, 1);
  assert.equal(unfinishedFence[0].type, "code");
  assert.equal(unfinishedFence[0].language, "bash");
  assert.match(unfinishedFence[0].content, /npm run build/);
});

test("prompt highlighting recognizes file mentions without matching email addresses", () => {
  const segments = promptHighlightSegments(
    "Open @main.tsx, then @metrics.csv) and not email@main.tsx",
    [
      { path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx" },
      { path: "reports/metrics.csv", name: "metrics.csv" },
    ],
  );
  assert.deepEqual(
    plain(segments.filter((segment) => segment.mention).map((segment) => segment.text)),
    ["@main.tsx", "@metrics.csv"],
  );
  assert.equal(segments.some((segment) => segment.mention && segment.text.includes("email")), false);
});

test("numbered list continuation increments the current item and places the caret after the marker", () => {
  assert.deepEqual(
    plain(continueNumberedList("1. First item", 13)),
    { value: "1. First item\n2. ", caret: 17 },
  );
  assert.deepEqual(
    plain(continueNumberedList("  09) Item", 10)),
    { value: "  09) Item\n  10) ", caret: 17 },
  );
  assert.deepEqual(
    plain(continueNumberedList("1.", 2)),
    { value: "1.\n2. ", caret: 6 },
  );
});

test("numbered list continuation replaces a selection and ignores non-list lines", () => {
  assert.deepEqual(
    plain(continueNumberedList("1. Keep selected", 7, 16)),
    { value: "1. Keep\n2. ", caret: 11 },
  );
  assert.equal(continueNumberedList("Write a normal line", 19), null);
});

test("an empty generated numbered item exits the list", () => {
  assert.deepEqual(
    plain(continueNumberedList("1. First item\n2. ", 17)),
    { value: "1. First item\n", caret: 14 },
  );
  assert.deepEqual(
    plain(continueNumberedList("1. First\n2. Second", 18)),
    { value: "1. First\n2. Second\n3. ", caret: 22 },
  );
});

test("pasted composer text removes only trailing empty lines and preserves the caret", () => {
  assert.deepEqual(
    plain(insertPastedComposerText("Before after", "one\r\n\r\n \r\n", 7, 7)),
    { value: "Before oneafter", caret: 10 },
  );
  assert.deepEqual(
    plain(insertPastedComposerText("Replace this text", "first\n\nsecond\n\n\n", 8, 12)),
    { value: "Replace first\n\nsecond text", caret: 21 },
  );
});

test("sent composer text ignores trailing empty lines", () => {
  assert.equal(composerPromptForSend("  Keep internal\n\nblank lines.\n \n\t\n"), "Keep internal\n\nblank lines.");
  assert.equal(composerPromptForSend("\n\n   \n"), "");
});

test("markdown preview truncates on a complete paragraph boundary", () => {
  const preview = markdownPreview(["First sentence.", "Second paragraph with plenty of room.", "Third paragraph."].join("\n\n"), 26);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, "First sentence.");
});

test("folder mentions carry a trailing slash so they read as folders", () => {
  assert.equal(attachmentMention({ path: "src/renderer", name: "renderer", kind: "folder" }), "@renderer/");
  assert.equal(attachmentMention({ path: "src/main.tsx", name: "main.tsx", kind: "file" }), "@main.tsx");
  assert.equal(attachmentMention({ path: "src/main.tsx", name: "main.tsx" }), "@main.tsx");
});

test("match highlighting marks the first case-insensitive occurrence of the query", () => {
  assert.deepEqual(plain(matchHighlightSegments("main.tsx", "main")), [
    { text: "main", hit: true },
    { text: ".tsx", hit: false },
  ]);
  assert.deepEqual(plain(matchHighlightSegments("apps/Desktop/main.tsx", "desk")), [
    { text: "apps/", hit: false },
    { text: "Desk", hit: true },
    { text: "top/main.tsx", hit: false },
  ]);
  assert.deepEqual(plain(matchHighlightSegments("styles.css", "zap")), [{ text: "styles.css", hit: false }]);
  assert.deepEqual(plain(matchHighlightSegments("styles.css", "  ")), [{ text: "styles.css", hit: false }]);
});

test("skill ranking puts prefix matches before substring and description matches", () => {
  const skills = [
    { id: "review", name: "Review", description: "Look over pending edits" },
    { id: "apple-design", name: "Apple Design", description: "Fluid interface guidance" },
    { id: "deploy", name: "Deploy", description: "Ship the app build" },
  ];
  assert.deepEqual(
    rankSkillMatches(skills, "app").map((skill) => skill.id),
    ["apple-design", "deploy"],
  );
  assert.deepEqual(
    rankSkillMatches(skills, "edits").map((skill) => skill.id),
    ["review"],
  );
  assert.deepEqual(
    rankSkillMatches(skills, "").map((skill) => skill.id),
    ["review", "apple-design", "deploy"],
  );
  assert.deepEqual(rankSkillMatches(skills, "zzz"), []);
});
