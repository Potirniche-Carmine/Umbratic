import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { UserPrompt } = loadRendererFile("UserPrompt.tsx");
const { CloudSubmitControls } = loadRendererFile("cloud/CloudSubmitControls.tsx");
const { QueuedPromptList } = loadRendererFile("queuedPromptList.tsx");
const { CloudRunControls } = loadRendererFile("cloud/CloudRunControls.tsx");
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("message screenshots sit outside and above the prompt bubble, including image-only messages", () => {
  const props = { text: "Explain these screenshots", files: ["one.png", "two.png"].map(name => ({ name, path: name, kind: "file", previewDataUrl: "data:image/png;base64,AA==" })), onOpen() {}, onCopy() {} };
  const html = render(UserPrompt, props);
  assert.ok(html.indexOf("messageAttachmentList") < html.indexOf("userMessageBubble"));
  assert.doesNotMatch(html.slice(html.indexOf("userMessageBubble")), /<img /);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.match(html, /Copy prompt/);
  const imageOnly = render(UserPrompt, { ...props, text: "" });
  assert.equal((imageOnly.match(/<img /g) || []).length, 2); assert.doesNotMatch(imageOnly, /userPromptText|userMessageBubble/);
  assert.doesNotMatch(render(UserPrompt, { ...props, files: [] }), /messageAttachmentList/);
  assert.match(render(UserPrompt, { ...props, text: "", feedback: React.createElement("button", null, "Review feedback") }), /userMessageBubble.*Review feedback/);
});

test("a generating cloud chat keeps Stop and Send without an extra steering button", () => {
  const props = { running: true, hasDraft: true, disabled: false, stopPending: false, sendOnEnter: true, onStop() {} };
  const html = render(CloudSubmitControls, props);
  for (const label of ["Stop work", "Send prompt"]) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.doesNotMatch(html, /aria-label="Steer with prompt"|queuedPromptSteer|Queue prompt/);
  assert.doesNotMatch(html, /disabled=""/);
  const empty = render(CloudSubmitControls, { ...props, hasDraft: false });
  assert.match(empty, /Stop work/); assert.doesNotMatch(empty, /Send prompt|Steer with prompt/);
  const idle = render(CloudSubmitControls, { ...props, running: false });
  assert.match(idle, /aria-label="Send prompt"/); assert.doesNotMatch(idle, /Stop work|Queue prompt|Steer with prompt/);
});

test("cloud queued prompts share editing, steering, deletion, and an idle resume action", () => {
  const props = { items: [{ id: "one", prompt: "Check tests" }], isGenerating: true, steerPending: false, onEdit() {}, onSteer() {}, onDelete() {}, onPreviewFeedback() {} };
  const html = render(QueuedPromptList, props);
  for (const label of ["Edit queued prompt", "Steer with queued prompt", "Delete queued prompt"]) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(render(QueuedPromptList, { ...props, isGenerating: false, sendWhenIdle: true }), /aria-label="Send queued prompt"/);
});

test("cloud approval and speed controls remain selectable for the next turn", () => {
  const settings = { provider: "codex", providers: { codex: { approvalMode: "manual", serviceTier: "default", orchestrator: { model: "model" } } } };
  const html = render(CloudRunControls, { settings, connection: { models: [{ id: "model", serviceTiers: [{ id: "fast", name: "Fast" }] }] }, disabled: false, onSave() {} });
  assert.match(html, /aria-label="Approvals"/); assert.match(html, /aria-label="Speed"/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""/);
});

test("ChatGPT and Claude keep one send action and route Enter to steering and Shift Enter to the queue", async () => {
  const { defaultCloudSettings } = loadTypeScriptModule(new URL("../src/shared/cloud.ts", import.meta.url), { realm: "host" });
  for (const provider of ["codex", "claude"]) {
    const settings = defaultCloudSettings(); settings.provider = provider;
    const choice = settings.providers[provider].orchestrator;
    const workspace = { key: "chat", provider, state: "running", approvals: [], entries: [{ id: "first", kind: "instruction", text: "First" }] };
    let editor;
    const requests = [];
    const { CloudWorkspace } = loadRendererFile("cloud/CloudWorkspace.tsx", {
      "./useCloudChats": { useCloudChats: () => ({ workspace, chats: [{ key: "chat", state: "running" }], repositoryIds: [], prompt: "Next instruction", images: [], feedback: [], loading: false, drafts: { current: new Map() }, setWorkspace() {}, setPrompt() {}, setImages() {}, setFeedback() {} }) },
      "../PromptTextarea": { PromptTextarea: props => { editor = props; return React.createElement("textarea", { "aria-label": props["aria-label"] }); } },
      "./CloudTimeline": { CloudTimeline: () => null, cloudImageAttachment: image => image },
      "./CloudChatArchive": { CloudChatArchive: () => null },
      "../dictation": { useDictation: () => ({ status: { state: "idle", preview: "", level: 0 }, devices: [] }) },
    });
    const controllers = Object.fromEntries(["codex", "claude"].map(id => [id, { working: "", checking: false, connection: { state: "ready", models: [{ id: choice.model, label: choice.model, efforts: [choice.effort], serviceTiers: [{ id: "fast", name: "Fast" }] }] } }]));
    const api = { sendCloudFollowUp: async input => { requests.push(input); return workspace; } };
    const html = render(CloudWorkspace, { settings, controllers, api, active: true, cloudBusy: true, settingsVisible: false, onActivity() {} });
    for (const label of ["Send prompt", "Approvals"]) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      assert.ok(button, `${provider} shows ${label}`); assert.doesNotMatch(button, /disabled=/);
    }
    const modelButton = html.match(/<button[^>]*class="cloudModelTrigger"[^>]*>/)?.[0];
    assert.ok(modelButton); assert.doesNotMatch(modelButton, /disabled=/);
    assert.doesNotMatch(html, /Settings changes apply to the next turn|queuedPromptSteer/);
    assert.doesNotMatch(html, /idePicker/);
    for (const shiftKey of [false, true]) {
      let prevented = false;
      editor.onKeyDown({ key: "Enter", shiftKey, metaKey: false, ctrlKey: false, nativeEvent: { isComposing: false }, currentTarget: { selectionStart: 16, selectionEnd: 16 }, preventDefault() { prevented = true; } });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(prevented);
    }
    assert.deepEqual(requests.map(input => ({ key: input.key, mode: input.mode, prompt: input.prompt })), [
      { key: "chat", mode: "steer", prompt: "Next instruction" },
      { key: "chat", mode: "queue", prompt: "Next instruction" },
    ]);
  }
});
