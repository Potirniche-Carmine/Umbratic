import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function loadAssistantMessage() {
  const icon = (props) => React.createElement("svg", props);
  return loadTypeScriptModule(new URL("../src/renderer/AssistantMessage.tsx", import.meta.url), {
    cache: new Map(), mocks: { "lucide-react": { Copy: icon } },
  }).AssistantMessage;
}

function buttons(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  if (node.type === "button") found.push(node);
  return buttons(node.props?.children, found);
}

function renderAnswer(overrides = {}) {
  const calls = [];
  const element = loadAssistantMessage()({
    item: { type: "assistant", id: "message-1", text: "The answer.", final: true },
    settled: true, copyText: "The answer.",
    onCopy: (value) => calls.push(value), children: null, ...overrides,
  });
  return { calls, element };
}

test("a settled answer offers copying without collecting response ratings", () => {
  const { calls, element } = renderAnswer();
  const actions = buttons(element);
  assert.deepEqual(actions.map((button) => button.props.title), ["Copy answer"]);
  actions[0].props.onClick();
  assert.deepEqual(calls, ["The answer."]);
});

test("answer actions wait until the answer settles", () => {
  assert.equal(buttons(renderAnswer({ settled: false }).element).length, 0);
  assert.equal(buttons(renderAnswer({ item: { type: "assistant", id: "m", text: "…", final: false } }).element).length, 0);
});
