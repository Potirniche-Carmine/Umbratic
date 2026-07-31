import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const feedback = loadTypeScriptModule(
  new URL("../src/shared/responseFeedback.ts", import.meta.url),
);

test("response feedback offers five optional reasons for each rating", () => {
  assert.equal(feedback.responseFeedbackReasons.good.length, 5);
  assert.equal(feedback.responseFeedbackReasons.bad.length, 5);
  assert.equal(feedback.isResponseFeedbackReason("good", "Solved my issue"), true);
  assert.equal(feedback.isResponseFeedbackReason("bad", "Solved my issue"), false);
});

test("thumb buttons open the dialog and only the form submit sends feedback", () => {
  const source = fs.readFileSync(
    new URL("../src/renderer/main.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /onClick=\{\(event\) => openResponseFeedbackDialog\(item\.id, "good", event\.currentTarget\)\}/);
  assert.match(source, /onClick=\{\(event\) => openResponseFeedbackDialog\(item\.id, "bad", event\.currentTarget\)\}/);
  assert.match(source, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);\s*void submitResponseFeedback\(\);/s);
  assert.equal(source.match(/api\.setResponseFeedback\(/g)?.length, 1);
  assert.match(
    source,
    /<button className="primaryAction" type="submit" disabled=\{responseFeedbackSubmitting\}>/,
  );
});
