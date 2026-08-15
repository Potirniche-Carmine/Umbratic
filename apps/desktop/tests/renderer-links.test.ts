import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const iconNames = [
  "AtSign", "BarChart3", "Brain", "Check", "ChevronDown", "ChevronRight", "CheckCircle2", "CircleDashed",
  "Copy", "ExternalLink", "File", "FileText", "FolderOpen", "GitBranch", "Hand", "Loader2",
  "Monitor", "Moon", "PanelRight", "Paperclip", "Pencil", "Play", "Plus", "RefreshCw", "Send", "Settings",
  "ShieldCheck", "Sparkles", "SquarePen", "SquareTerminal", "Sun", "ThumbsDown", "ThumbsUp",
  "Trash2", "TriangleAlert", "Type", "Undo2", "User", "X",
];

function browserGlobals() {
  const storage = new Map();
  const documentElement = {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty() {},
    },
  };
  return {
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, style: {}, select() {} }),
      documentElement,
      execCommand: () => true,
      getElementById: () => null,
    },
    navigator: { clipboard: undefined, platform: "Win32" },
    window: {
      clearTimeout,
      document: null,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      location: { search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (callback) => {
        callback();
        return 0;
      },
      setTimeout,
      umbratic: undefined,
    },
  };
}

function loadMarkdown() {
  const icon = (props) => React.createElement("svg", props);
  const lucide = Object.fromEntries(iconNames.map((name) => [name, icon]));
  return loadTypeScriptModule(new URL("../src/renderer/markdownContent.tsx", import.meta.url), {
    cache: new Map(),
    globals: browserGlobals(),
    mocks: {
      "lucide-react": lucide,
      "react-dom/client": {
        createRoot: () => ({ render() {} }),
      },
    },
  });
}

// A reply that cites its sources used to show the raw `[label](url)` syntax,
// which is the one piece of markdown the renderer never learned.
test("markdown links render as links and keep their label formatting", () => {
  const { MarkdownContent } = loadMarkdown();
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: "Built with [Next.js](https://nextjs.org/) and [**Tailwind**](https://tailwindcss.com/).",
    }),
  );
  assert.match(html, /<a[^>]+href="https:\/\/nextjs\.org\/"[^>]*>Next\.js<\/a>/);
  assert.match(html, /<a[^>]+href="https:\/\/tailwindcss\.com\/"[^>]*><strong>Tailwind<\/strong><\/a>/);
  // A link that leaves the app must not leak the referrer or hand the target a
  // window handle.
  assert.match(html, /rel="noreferrer noopener"/);
  assert.doesNotMatch(html, /\[Next\.js\]/);
});

// The label is attacker-supplied and the URL is where the attack would live, so
// an unsafe scheme is shown exactly as written rather than hidden behind text
// that claims to be somewhere else.
test("an unsafe link URL is left visible instead of becoming an anchor", () => {
  const { MarkdownContent } = loadMarkdown();
  for (const raw of [
    "[Click here](javascript:alert(1))",
    "[Trusted site](data:text/html,<script>alert(1)</script>)",
    "[Local file](file:///etc/passwd)",
  ]) {
    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: raw }));
    assert.doesNotMatch(html, /<a /, raw);
    assert.match(html, /\[/, raw);
  }
});

test("bracketed text that is not a link is untouched", () => {
  const { MarkdownContent } = loadMarkdown();
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: "See [1] and [not a link] (parens)." }),
  );
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /\[1\]/);
  assert.match(html, /\[not a link\]/);
});

test("link parsing survives brackets in the label and parentheses in the URL", () => {
  const { MarkdownContent } = loadMarkdown();
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: "[Ruby [lang]](https://en.wikipedia.org/wiki/Ruby_(programming_language)) ships.",
    }),
  );
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Ruby_\(programming_language\)"/);
  assert.match(html, /ships\./);
});
