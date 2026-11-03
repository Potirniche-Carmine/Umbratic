import assert from "node:assert/strict";
import test from "node:test";
import { advanceStreamingText } from "../src/renderer/streamingText.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("streaming frames are monotonic, unicode-safe, and flush exact corrections", () => {
  const target = "A 😀 response\n\n```ts\nconst a = 1;\n```";
  let shown = "A ";
  while (shown !== target) {
    const next = advanceStreamingText(shown, target, .05);
    assert.ok(next.length > shown.length); assert.ok(target.startsWith(next));
    assert.ok(next.isWellFormed()); shown = next;
  }
  assert.equal(advanceStreamingText(shown, "Corrected response", .1), "Corrected response");
  assert.equal(advanceStreamingText("A", target, 1), target);
  assert.equal(advanceStreamingText(shown, "", .1), "");
});

test("rapid chunks keep a scheduled frame; completion and unmount cancel it", () => {
  const values = []; const deps = []; const cleanups = []; let cursor = 0; let effects = []; let now = 0; let id = 0;
  const frames = new Map();
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useLayoutEffect(fn, next) { const i = cursor++; if (!deps[i] || next.some((value, n) => !Object.is(value, deps[i][n]))) { effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); deps[i] = next; } },
  };
  const { useStreamingText } = loadTypeScriptModule(new URL("../src/renderer/useStreamingText.ts", import.meta.url), {
    realm: "host", mocks: { react: hooks }, globals: {
      window: { matchMedia: () => ({ matches: false }) }, performance: { now: () => now },
      requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: key => frames.delete(key),
    },
  });
  const render = (text, streaming = true) => { cursor = 0; const value = useStreamingText(text, streaming); const pending = effects; effects = []; pending.forEach(fn => fn()); return value; };
  render("First"); render("First chunk"); const scheduled = [...frames.keys()][0];
  now = 8; render("First chunk and another"); assert.ok(frames.has(scheduled));
  now = 16; const callback = frames.get(scheduled); frames.delete(scheduled); callback(now);
  assert.ok(render("First chunk and another").length > "First".length);
  assert.equal(render("First chunk and another", false), "First chunk and another"); assert.equal(frames.size, 0);
  render("First chunk and another burst"); assert.equal(frames.size, 1);
  cleanups.forEach(cleanup => cleanup?.()); assert.equal(frames.size, 0);
});
