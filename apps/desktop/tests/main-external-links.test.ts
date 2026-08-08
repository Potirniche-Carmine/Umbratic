import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function loadOpener(behavior: { fail?: boolean } = {}) {
  const opened: string[] = [];
  const module = loadTypeScriptModule(new URL("../src/main/externalLinks.ts", import.meta.url), {
    cache: new Map(),
    mocks: {
      electron: {
        shell: {
          async openExternal(url: string) {
            opened.push(url);
            if (behavior.fail) throw new Error("no handler for this scheme");
          },
        },
      },
    },
  });
  return { openExternalLink: module.openExternalLink, opened };
}

test("the main process opens only browser-safe links", async () => {
  const { openExternalLink, opened } = loadOpener();
  assert.equal((await openExternalLink("https://nextjs.org/")).ok, true);
  assert.equal((await openExternalLink("mailto:someone@example.com")).ok, true);
  assert.deepEqual(opened, ["https://nextjs.org/", "mailto:someone@example.com"]);
});

// The renderer refusing to render an unsafe anchor is a display decision. This
// is the boundary that has to hold even when the caller is not the renderer we
// shipped.
test("an unsafe URL never reaches the operating system", async () => {
  const { openExternalLink, opened } = loadOpener();
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "java\tscript:alert(1)",
    "not a url",
    undefined,
    null,
    { url: "https://example.com" },
  ]) {
    assert.equal((await openExternalLink(url)).ok, false, String(url));
  }
  assert.deepEqual(opened, [], "an unsafe URL was handed to the shell");
});

test("a failed hand-off is reported rather than thrown", async () => {
  const { openExternalLink } = loadOpener({ fail: true });
  assert.equal((await openExternalLink("https://example.com/")).ok, false);
});
