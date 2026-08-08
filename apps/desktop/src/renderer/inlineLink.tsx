import React from "react";

import { externalUrlTitle } from "../shared/externalLink";
import { isEscapedMarkdownAt } from "./composerText";

/**
 * Reads a `[label](url)` starting at `index`, or null if there is no complete
 * one there. Nesting is counted so a label containing brackets and a URL
 * containing parentheses — a Wikipedia link, say — still close correctly.
 */
export function readMarkdownLink(text: string, index: number): { label: string; url: string; end: number } | null {
  if (text[index] !== "[") return null;
  let depth = 0;
  let labelEnd = -1;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\n") return null;
    if (char === "[" && !isEscapedMarkdownAt(text, cursor)) depth += 1;
    else if (char === "]" && !isEscapedMarkdownAt(text, cursor)) {
      depth -= 1;
      if (depth === 0) {
        labelEnd = cursor;
        break;
      }
    }
  }
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  let parens = 0;
  for (let cursor = labelEnd + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\n") return null;
    if (char === "(") parens += 1;
    else if (char === ")") {
      parens -= 1;
      if (parens === 0) {
        return {
          label: text.slice(index + 1, labelEnd),
          url: text.slice(labelEnd + 2, cursor),
          end: cursor,
        };
      }
    }
  }
  return null;
}

/**
 * A link in a reply. The href is model output, so an unsafe scheme never
 * becomes an anchor at all — the caller renders the original text instead, so
 * a hostile URL stays visible rather than being quietly hidden behind a label.
 *
 * The click is handled rather than followed: the window refuses to navigate
 * away from the app, so the main process opens the URL in the real browser.
 */
export function InlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="inlineLink"
      href={href}
      title={externalUrlTitle(href)}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        void window.umbratic?.openExternal({ url: href });
      }}
    >
      {children}
    </a>
  );
}
