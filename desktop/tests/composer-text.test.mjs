import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
  markdownPreview,
  parseMarkdown,
  promptHighlightSegments,
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

assert.deepEqual(plain(splitMarkdownTableRow("| one | two\\|three | `a|b` |")), ["one", "two|three", "`a|b`"]);

const unfinishedFence = parseMarkdown('```bash\nnpm run build && echo "done"');
assert.equal(unfinishedFence.length, 1);
assert.equal(unfinishedFence[0].type, "code");
assert.equal(unfinishedFence[0].language, "bash");
assert.match(unfinishedFence[0].content, /npm run build/);

const segments = promptHighlightSegments(
  "Open @main.tsx, then @metrics.csv) and not email@main.tsx",
  [
    { path: "desktop/src/renderer/main.tsx", name: "main.tsx" },
    { path: "reports/metrics.csv", name: "metrics.csv" },
  ],
);
assert.deepEqual(
  plain(segments.filter((segment) => segment.mention).map((segment) => segment.text)),
  ["@main.tsx", "@metrics.csv"],
);
assert.equal(segments.some((segment) => segment.mention && segment.text.includes("email")), false);

const preview = markdownPreview(["First sentence.", "Second paragraph with plenty of room.", "Third paragraph."].join("\n\n"), 26);
assert.equal(preview.truncated, true);
assert.equal(preview.text, "First sentence.");

console.log("composer text tests passed");
