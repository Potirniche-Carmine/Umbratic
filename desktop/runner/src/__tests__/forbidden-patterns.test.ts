import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") && !full.includes("__tests__")) yield full;
  }
}

const forbidden = [
  /\bposthog\b|\bsentry\b|\bmixpanel\b/i,
  /\bexa\b|\btavily\b|\bserpapi\b/i,
  /api\.openai\.com/i,
  /api\.anthropic\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /openrouter\.ai/i,
  /\bautoupdate\b|\bself[_-]?update\b/i,
  /https?:\/\/(?!127\.|localhost|\[::1\]|ai\.[a-z0-9.-]+\.internal)/i,
];

test("runner source contains no forbidden patterns", () => {
  for (const file of walk("src")) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = text.match(pattern);
      if (match) throw new Error(`${file} contains forbidden pattern ${pattern}: ${match[0]}`);
    }
  }
});
