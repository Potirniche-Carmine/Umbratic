import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const history = loadTypeScriptModule(new URL("../src/main/historyContext.ts", import.meta.url));

test("boundedRecentLines preserves newest conversation context when the budget is exhausted", () => {
  const value = history.boundedRecentLines(["oldest-0000", "middle-1111", "newest-2222"], 60, 20);
  assert.equal(value, "middle-1\nnewest-2222");
});

test("boundedRecentLines applies the event-count limit before the character budget", () => {
  assert.equal(history.boundedRecentLines(["one", "two", "three"], 2, 100), "two\nthree");
  assert.equal(history.boundedRecentLines(["one"], 0, 100), "");
});
