import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const utcDate = loadTypeScriptModule(new URL("../src/shared/utcDate.ts", import.meta.url));
const presentation = loadTypeScriptModule(new URL("../src/renderer/chatListPresentation.ts", import.meta.url));

const now = Date.parse("2026-08-16T22:18:00.000Z");

test("naive SQLite datetimes are UTC, not local wall time", () => {
  assert.equal(utcDate.parseUtcMs("2026-08-16 21:18:00"), Date.parse("2026-08-16T21:18:00.000Z"));
  assert.equal(utcDate.parseUtcMs("2026-08-16T21:18:00"), Date.parse("2026-08-16T21:18:00.000Z"));
  assert.equal(utcDate.normalizeUtcIso("2026-08-16 21:18:00"), "2026-08-16T21:18:00.000Z");
});

test("unix seconds and milliseconds parse as instants", () => {
  assert.equal(utcDate.parseUtcMs("1755383880"), 1755383880 * 1000);
  assert.equal(utcDate.parseUtcMs("1755383880000"), 1755383880000);
});

test("chat activity prefers the last event datetime over a later row write", () => {
  assert.equal(
    utcDate.chatActivityUtcIso(
      {
        createdAt: "2026-08-16T10:00:00.000Z",
        events: [
          { type: "user.message", at: "2026-08-16T20:00:00.000Z" },
          { type: "assistant.done", at: "2026-08-16T21:18:00.000Z" },
        ],
      },
      "2026-08-16T22:17:00.000Z",
    ),
    "2026-08-16T21:18:00.000Z",
  );
  assert.equal(
    utcDate.chatActivityUtcIso({ createdAt: "2026-08-16T10:00:00.000Z", events: [] }, "2026-08-16T12:00:00.000Z"),
    "2026-08-16T12:00:00.000Z",
  );
});

test("sidebar ages are computed from the stored UTC datetime", () => {
  assert.equal(presentation.relativeChatAge("2026-08-16T22:17:30.000Z", now), "<1m");
  assert.equal(presentation.relativeChatAge("2026-08-16T21:18:00.000Z", now), "1h");
  assert.equal(presentation.relativeChatAge("2026-08-16 21:18:00", now), "1h");
  assert.equal(presentation.relativeChatAge("2026-08-16T20:18:00.000Z", now), "2h");
  assert.equal(presentation.relativeChatAge("2026-08-15T22:18:00.000Z", now), "1d");
  assert.equal(
    presentation.chatSubline({ id: "chat-1", title: "Hello", createdAt: "", updatedAt: "2026-08-16T21:18:00.000Z" }, now),
    "1h",
  );
});
