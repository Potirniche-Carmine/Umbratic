import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function adapter(fetch) {
  return loadTypeScriptModule(new URL("../src/main/runnerAdapter.ts", import.meta.url), {
    mocks: { electron: {} },
    globals: { fetch },
  });
}

function run() {
  return { url: "http://127.0.0.1:12345", password: "test", abortController: new AbortController() };
}

test("cancelling before the event connection opens settles readiness and completion", async () => {
  const aborted = new Error("cancelled");
  const runner = run();
  const { beginRunnerEventStream } = adapter(async (_url, { signal }) => {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(aborted), { once: true }));
  });
  const stream = beginRunnerEventStream(runner, () => assert.fail("no event expected"));
  const readiness = assert.rejects(stream.ready, /cancelled/);
  runner.abortController.abort();
  let timer;
  try {
    await Promise.race([
      Promise.all([readiness, stream.done]),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("readiness never settled")), 200); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("event decoding preserves split UTF-8, split CRLF delimiters, and event order", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"雪"}\r\n\r\ndata: {"text":"second"}\n\n');
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const { beginRunnerEventStream } = adapter(async () => ({ ok: true, body }));
  const events = [];
  const stream = beginRunnerEventStream(run(), (event) => events.push(event.text));
  await stream.ready;
  await stream.done;
  assert.deepEqual(events, ["雪", "second"]);
  assert.equal(body.locked, false);
});

test("an event callback failure cancels the reader and releases its lock", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"text":"first"}\n\n')); },
    cancel() { cancelled = true; },
  });
  const { beginRunnerEventStream } = adapter(async () => ({ ok: true, body }));
  const stream = beginRunnerEventStream(run(), () => { throw new Error("callback failed"); });
  await stream.ready;
  await assert.rejects(stream.done, /callback failed/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
