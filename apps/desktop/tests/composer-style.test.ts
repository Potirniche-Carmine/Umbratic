import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readStyleGraph(stylesheet: URL, seen = new Set<string>()): string {
  if (seen.has(stylesheet.href)) return "";
  seen.add(stylesheet.href);
  const source = readFileSync(stylesheet, "utf8");
  const imports = Array.from(
    source.matchAll(/@import\s+["'](?<path>[^"']+)["'];/g),
    (match) => match.groups?.path,
  ).filter((value): value is string => Boolean(value));
  return [
    source,
    ...imports.map((relativePath) =>
      readStyleGraph(new URL(relativePath, stylesheet), seen)),
  ].join("\n");
}

const styles = readStyleGraph(
  new URL("../src/renderer/styles.css", import.meta.url),
);

test("prompt mention overlay preserves the textarea's font metrics", () => {
  const mentionRules = Array.from(
    styles.matchAll(/\.promptMentionToken\s*\{(?<declarations>[^}]*)\}/g),
    (match) => match.groups?.declarations ?? "",
  );

  assert.ok(mentionRules.length > 0, "prompt mention styling should be present");
  assert.ok(mentionRules.some((rule) => /font-weight:\s*inherit\s*;/.test(rule)));
});
