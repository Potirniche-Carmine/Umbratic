import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const feedback = loadTypeScriptModule(
  new URL("../src/shared/responseFeedback.ts", import.meta.url),
);

function loadAssistantMessage() {
  const icon = (props) => React.createElement("svg", props);
  return loadTypeScriptModule(new URL("../src/renderer/assistantMessage.tsx", import.meta.url), {
    cache: new Map(),
    mocks: {
      "lucide-react": { Copy: icon, ThumbsDown: icon, ThumbsUp: icon },
    },
  }).AssistantMessage;
}

/** Every <button> in a rendered element tree, in document order. */
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
  const AssistantMessage = loadAssistantMessage();
  const calls = [];
  const element = AssistantMessage({
    item: { type: "assistant", id: "message-1", text: "The answer.", final: true },
    settled: true,
    canRate: true,
    rating: undefined,
    copyText: "The answer.",
    onCopy: () => {},
    onRate: (...args) => calls.push(args),
    children: null,
    ...overrides,
  });
  return { calls, element };
}

test("response feedback offers five optional reasons for each rating", () => {
  assert.equal(feedback.responseFeedbackReasons.good.length, 5);
  assert.equal(feedback.responseFeedbackReasons.bad.length, 5);
  assert.equal(feedback.isResponseFeedbackReason("good", "Solved my issue"), true);
  assert.equal(feedback.isResponseFeedbackReason("bad", "Solved my issue"), false);
});

// The thumbs must report which message was rated, which way, and which element
// to anchor the dialog to. Asserting the call rather than the source text keeps
// this true wherever the buttons live.
test("each thumb reports its message, its rating, and the button to anchor to", () => {
  for (const rating of ["good", "bad"]) {
    const { calls, element } = renderAnswer();
    const thumb = buttons(element).find((button) => button.props.title === `${rating === "good" ? "Good" : "Bad"} response`);
    assert.ok(thumb, `no ${rating} thumb was rendered`);
    assert.equal(thumb.props["aria-haspopup"], "dialog");

    const anchor = { id: "the-clicked-button" };
    thumb.props.onClick({ currentTarget: anchor });
    assert.deepEqual(calls, [["message-1", rating, anchor]]);
  }
});

// A rating is an opinion about a finished answer. Offering the thumbs mid-run
// would collect one about a response the model has not finished writing.
test("thumbs appear only on a settled answer", () => {
  assert.equal(buttons(renderAnswer({ settled: false }).element).length, 0);
  assert.equal(
    buttons(renderAnswer({ item: { type: "assistant", id: "m", text: "…", final: false } }).element).length,
    0,
  );
});

test("clicking a thumb opens the dialog, and only the form submit sends feedback", () => {
  const source = fs.readFileSync(
    new URL("../src/renderer/main.tsx", import.meta.url),
    "utf8",
  );
  // The click has to reach the dialog opener; the assertion above proves the
  // button reports the anchor, and this proves the anchor is what opens it.
  assert.match(source, /onRate=\{openResponseFeedbackDialog\}/);
  assert.match(source, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);\s*void submitResponseFeedback\(\);/s);
  assert.equal(source.match(/api\.setResponseFeedback\(/g)?.length, 1);
  assert.match(
    source,
    /<button className="primaryAction" type="submit" disabled=\{responseFeedbackSubmitting\}>/,
  );
});
