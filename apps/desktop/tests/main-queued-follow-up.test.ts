import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import React from "react";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

/**
 * A queued message answers inside the *same run* as the message before it.
 * Both halves of that — the order the answers are stored in, and where the
 * transcript decides one message ends — used to be wrong in the same direction,
 * and the two answers rendered as a single bubble whose second half continued
 * the first mid-sentence.
 */

const iconNames = [
  "AtSign", "BarChart3", "Brain", "Check", "ChevronDown", "ChevronRight", "CheckCircle2", "CircleDashed",
  "Copy", "ExternalLink", "File", "FileText", "FolderOpen", "GitBranch", "Hand", "Loader2",
  "Monitor", "Moon", "PanelRight", "Paperclip", "Pencil", "Play", "Plus", "RefreshCw", "Send", "Settings",
  "ShieldCheck", "Sparkles", "SquarePen", "SquareTerminal", "Sun", "ThumbsDown", "ThumbsUp",
  "Trash2", "TriangleAlert", "Type", "Undo2", "User", "X",
];

function browserGlobals() {
  const storage = new Map<string, string>();
  return {
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, style: {}, select() {} }),
      documentElement: { dataset: {}, style: { colorScheme: "", setProperty() {} } },
      execCommand: () => true,
      getElementById: () => null,
    },
    navigator: { clipboard: undefined, platform: "Win32" },
    window: {
      clearTimeout,
      document: null,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, String(value)),
      },
      location: { search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
      setTimeout,
      umbratic: undefined,
    },
  };
}

function loadRenderer() {
  const icon = (props: unknown) => React.createElement("svg", props as object);
  return loadTypeScriptModule(new URL("../src/renderer/main.tsx", import.meta.url), {
    cache: new Map(),
    globals: browserGlobals(),
    mocks: {
      "lucide-react": Object.fromEntries(iconNames.map((name) => [name, icon])),
      "react-dom/client": { createRoot: () => ({ render() {} }) },
    },
  });
}

function loadRuntime() {
  const tasks = new Map<string, Record<string, unknown>>();
  const runtime = loadTypeScriptModule(new URL("../src/main/mainRuntime.ts", import.meta.url), {
    cache: new Map(),
    mocks: {
      electron: {
        app: { getPath: () => os.tmpdir(), on: () => {}, whenReady: async () => {} },
        BrowserWindow: class { static getAllWindows() { return []; } },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      },
      "./storage": {
        readTask: (id: string) => tasks.get(id) ?? null,
        writeTask: (task: { id: string }) => { tasks.set(task.id, task); },
        readTasks: () => [...tasks.values()],
        writeTasks: () => {},
        writeChat: () => {},
        writeProductTelemetryEvent: () => {},
        readPermissionModeSetting: () => "normal",
      },
      "./chatStore": { updateChatFromTask: () => {} },
      "./backendSettings": { scheduleManagedTelemetrySync: () => {} },
      "./diagnostics": { recordBackendEventDiagnostic: () => {}, recordLocalDiagnostic: () => {} },
    },
  });
  return { runtime, tasks };
}

test("a queued follow-up's message is stored after the answer it followed", () => {
  const { runtime, tasks } = loadRuntime();
  const task = { id: "task-1", chatId: "chat-1", events: [] as Array<Record<string, unknown>> };
  tasks.set(task.id, task);

  runtime.appendUserMessage(task, "hey there", []);
  // The answer to the first message. Streaming events are held in memory and
  // flushed on a timer, so at the moment the queued message is released this is
  // still only buffered — which is exactly the state the ordering bug needed.
  runtime.recordTaskEvent({
    type: "assistant.delta",
    taskId: task.id,
    text: "Hello! How can I help you today?",
    at: "2026-01-01T00:00:01.000Z",
  });
  runtime.recordTaskEvent({ type: "turn.outcome", taskId: task.id, outcome: "completed" });
  runtime.appendUserMessage(task, "can you tell me more about C# vs Python vs C", []);

  const stored = tasks.get(task.id) as { events: Array<{ type: string; text?: string }> };
  // The module runs in its own vm realm, so its arrays fail a strict deep
  // compare on prototype alone. Only the values matter here.
  assert.deepEqual(
    Array.from(stored.events, (event) => event.type),
    ["user.message", "assistant.delta", "turn.outcome", "user.message"],
  );
  assert.equal(stored.events[3].text, "can you tell me more about C# vs Python vs C");
});

test("two turns answered in one run render as two assistant messages", () => {
  const { composerTimelineFromEvents } = loadRenderer();
  const timeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "hey there", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Hello! How can I help you today?", at: "2026-01-01T00:00:01.000Z" },
    { type: "turn.outcome", taskId: "task-1", outcome: "completed", at: "2026-01-01T00:00:02.000Z" },
    { type: "user.message", taskId: "task-1", text: "C# vs Python vs C", at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Those are three very different languages.", at: "2026-01-01T00:00:04.000Z" },
    // One `assistant.done` for the whole run, which is why it cannot be the
    // boundary between the two answers.
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ]);

  assert.deepEqual(Array.from(timeline, (item: { type: string }) => item.type), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  assert.equal(timeline[1].text, "Hello! How can I help you today?");
  assert.equal(timeline[3].text, "Those are three very different languages.");
});

test("an already-stored log with the follow-up out of order still reads as two answers", () => {
  // The order chats written before the ordering fix have on disk: the queued
  // message jumped ahead of the answer it followed. Those logs cannot be
  // rewritten, so the transcript has to read them correctly — which it does,
  // because `turn.outcome` separates the answers on its own.
  const { composerTimelineFromEvents } = loadRenderer();
  const timeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "hey there", at: "2026-01-01T00:00:00.000Z" },
    { type: "user.message", taskId: "task-1", text: "C# vs Python vs C", at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Hello! How can I help you today?", at: "2026-01-01T00:00:01.000Z" },
    { type: "turn.outcome", taskId: "task-1", outcome: "completed", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Those are three very different languages.", at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ]);

  const assistants = timeline.filter((item: { type: string }) => item.type === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].text, "Hello! How can I help you today?");
  assert.equal(assistants[1].text, "Those are three very different languages.");
  // The symptom this reproduces: one bubble running the two answers together.
  assert.doesNotMatch(assistants[0].text, /today\?Those/);
});

test("a completed turn closes its answer even when the next one has not started", () => {
  const { composerTimelineFromEvents } = loadRenderer();
  const timeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "hey there", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "First answer.", at: "2026-01-01T00:00:01.000Z" },
    { type: "turn.outcome", taskId: "task-1", outcome: "completed", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Second answer.", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "running");

  const assistants = timeline.filter((item: { type: string }) => item.type === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].text, "First answer.");
  assert.equal(assistants[0].streaming, undefined);
  // The turn still running is the one that reads as live.
  assert.equal(assistants[1].text, "Second answer.");
  assert.equal(assistants[1].streaming, true);
});
