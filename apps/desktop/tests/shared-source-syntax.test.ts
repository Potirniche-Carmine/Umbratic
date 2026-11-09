import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
import { loadRendererFile } from "./helpers/load-renderer.ts";
import { sourceTokenSpans } from "../src/renderer/sourceTokenSpans.ts";
import { diffSyntaxSections, diffSyntaxKey, mapDiffSyntax } from "../src/renderer/review/diffSyntax.ts";
import { highlightSource } from "../src/renderer/sourceSyntax.ts";

const { SyntaxRequests } = loadTypeScriptModule(new URL("../src/renderer/syntaxRequests.ts", import.meta.url), { realm: "host" });
function fixture() {
  const workers = [];
  const client = new SyntaxRequests(() => {
    const worker = { sent: [], terminated: false, onmessage: null, onerror: null,
      postMessage(message) { this.sent.push(message); }, terminate() { this.terminated = true; },
      reply(index = this.sent.length - 1) { const message = this.sent[index]; this.onmessage({ data: { id: message.id, results: message.documents.map(document => ({ language: "test", lines: [[{ content: document.text }]] })) } }); },
    };
    workers.push(worker); return worker;
  });
  return { client, workers };
}

test("shared syntax requests coalesce identical views and reuse completed results", async () => {
  const { client, workers } = fixture();
  const documents = [{ path: "main.c", text: "return 1;" }];
  const first = client.request(documents), second = client.request(documents);
  assert.equal(workers.length, 1); assert.equal(workers[0].sent.length, 1);
  workers[0].reply();
  assert.deepEqual(await first.promise, await second.promise);
  assert.deepEqual(await client.request(documents).promise, await first.promise);
  assert.equal(workers[0].sent.length, 1);
});

test("streaming drops superseded queued work and ignores unrelated replies", async () => {
  const { client, workers } = fixture();
  const active = client.request([{ text: "one", language: "ts" }]);
  const stale = client.request([{ text: "two", language: "ts" }]);
  stale.cancel(); assert.equal(await stale.promise, null);
  const latest = client.request([{ text: "three", language: "ts" }]);
  workers[0].onmessage({ data: { id: -1, results: [] } });
  assert.equal(workers[0].sent.length, 1);
  workers[0].reply(); await active.promise;
  assert.equal(workers[0].sent.length, 2);
  assert.equal(workers[0].sent[1].documents[0].text, "three");
  workers[0].reply(); assert.equal((await latest.promise)[0].lines[0][0].content, "three");
});

test("worker failure settles readers and a later request can recover", async () => {
  const { client, workers } = fixture();
  const first = client.request([{ text: "one" }]), queued = client.request([{ text: "two" }]);
  workers[0].onerror();
  assert.equal(await first.promise, null); assert.equal(await queued.promise, null); assert.ok(workers[0].terminated);
  const retry = client.request([{ text: "three" }]);
  assert.equal(workers.length, 2); workers[1].reply(); assert.ok(await retry.promise);
});

test("diff marks intersect syntax tokens without losing spaces, text or colors", () => {
  const text = 'const name = "blue";';
  const tokens = [{ content: "const", dark: "#f00" }, { content: ' name = "blue";', dark: "#0f0" }];
  const changes = [{ text: 'const name = "', changed: false }, { text: "blue", changed: true }, { text: '";', changed: false }];
  const groups = sourceTokenSpans(text, tokens, changes);
  assert.equal(groups.flatMap(group => group.tokens).map(token => token.content).join(""), text);
  assert.equal(groups[1].tokens[0].content, "blue"); assert.equal(groups[1].tokens[0].dark, "#0f0");
  assert.equal(groups[1].changed, true);
  assert.equal(sourceTokenSpans("new text", [{ content: "old text", dark: "red" }])[0].tokens[0].content, "new text");
  assert.equal(sourceTokenSpans("new text", [{ content: "old text", dark: "red" }])[0].tokens[0].dark, undefined);
});

test("syntax spans remain escaped text, including inside changed-word marks", () => {
  const { SourceTokens } = loadRendererFile("SourceTokens.tsx");
  const html = renderToStaticMarkup(React.createElement(SourceTokens, { text: '<script>bad()</script>', tokens: [{ content: '<script>bad()</script>', dark: '#f00' }], changes: [{ text: '<script>bad()</script>', changed: true }] }));
  assert.match(html, /intraLineChange/); assert.match(html, /sourceToken/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("diff excerpts keep before/after states and distant hunks separate with exact line mapping", async () => {
  const { parseReviewPatch } = loadTypeScriptModule(new URL("../src/shared/reviewDiff.ts", import.meta.url));
  const file = parseReviewPatch(['diff --git a/main.c b/main.c', '--- a/main.c', '+++ b/main.c', '@@ -10,3 +10,3 @@', ' /* note', '- * before', '+ * after', '  */', '@@ -90 +90 @@', '-return 0;', '+return 1;'].join('\n'));
  const sections = diffSyntaxSections(file);
  assert.equal(sections.length, 4);
  assert.equal(sections[0].document.text, '/* note\n * before\n */');
  assert.equal(sections[1].document.text, '/* note\n * after\n */');
  const results = await Promise.all(sections.map(section => highlightSource(section.document.path, section.document.text)));
  const map = mapDiffSyntax(sections, results);
  const tokens = map.get(diffSyntaxKey(file.hunks[1].id, { side: "new", line: 90 }));
  assert.equal(tokens.map(token => token.content).join(""), "return 1;");
  assert.notEqual(tokens[0].dark, results[1].lines[1][0].dark);
});
