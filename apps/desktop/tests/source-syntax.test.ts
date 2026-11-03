import assert from "node:assert/strict";
import test from "node:test";
import { highlightSource, sourceLanguage } from "../src/renderer/sourceSyntax.ts";

test("source language follows filename, extensions and extensionless shebangs", () => {
  for (const [path, expected] of [["src/main.c", "c"], ["src/header.hpp", "cpp"], ["App.tsx", "tsx"], ["tool.py", "python"], ["CMakeLists.txt", "cmake"], ["Dockerfile", "dockerfile"], [".env.local", "dotenv"], ["config.yml", "yaml"], ["source.rs", "rust"], ["thing.unknown", "text"]]) assert.equal(sourceLanguage(path), expected);
  assert.equal(sourceLanguage("bin/tool", "#!/usr/bin/env python3\nprint(1)"), "python");
});

test("C functions, strings and comments get distinct colors without altering source or line offsets", async () => {
  const code = '/* multiple\n * lines */\nint main(void) {\n  printf("Hello");\n  return 0;\n}\n';
  const highlighted = await highlightSource("main.c", code);
  assert.equal(highlighted.language, "C");
  assert.deepEqual(highlighted.lines.map(line => line.map(token => token.content).join("")), code.split("\n"));
  const tokens = highlighted.lines.flat();
  const fn = tokens.find(token => token.content === "main");
  const keyword = tokens.find(token => token.content === "return");
  const comment = tokens.find(token => token.content.includes("multiple"));
  assert.ok(fn?.dark && fn?.light && keyword?.dark && comment?.dark);
  assert.notEqual(fn.dark, keyword.dark); assert.notEqual(comment.dark, keyword.dark);
});

test("multiple grammars and plain text preserve source including unsafe markup", async () => {
  for (const [path, code] of [["a.tsx", 'const view = <div title="hello">world</div>;'], ["a.py", 'def greet(name):\n    return f"Hi {name}"'], ["a.rs", 'fn main() { println!("hello"); }'], ["notes.txt", '<script>alert(1)</script>\nplain']]) {
    const highlighted = await highlightSource(path, code);
    assert.equal(highlighted.lines.map(line => line.map(token => token.content).join("")).join("\n"), code);
  }
});
