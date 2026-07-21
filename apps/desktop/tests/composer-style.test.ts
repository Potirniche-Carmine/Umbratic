import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

test("prompt mention overlay preserves the textarea's font metrics", () => {
  const mentionRules = Array.from(
    styles.matchAll(/\.promptMentionToken\s*\{(?<declarations>[^}]*)\}/g),
    (match) => match.groups?.declarations ?? "",
  );

  assert.ok(mentionRules.length > 0, "prompt mention styling should be present");
  assert.ok(mentionRules.some((rule) => /font-weight:\s*inherit\s*;/.test(rule)));
});
