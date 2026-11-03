import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
const { promptEnterAction } = loadTypeScriptModule(new URL("../src/renderer/promptKeyboard.ts", import.meta.url), { realm: "host" });
const input = (value, overrides = {}) => ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, sendOnEnter: true, value, start: value.length, end: value.length, ...overrides });
test("shared prompt keyboard honors send preference and IME composition", () => {
  assert.equal(promptEnterAction(input("hello")).type, "send");
  assert.equal(promptEnterAction(input("hello", { isComposing: true })), null);
  assert.equal(promptEnterAction(input("hello", { shiftKey: true })), null);
  assert.equal(promptEnterAction(input("hello", { sendOnEnter: false })), null);
  assert.equal(promptEnterAction(input("hello", { sendOnEnter: false, metaKey: true })).type, "send");
});
test("Shift Enter continues numbered, bullet and task lists and exits an empty bullet", () => {
  for (const [from, to] of [["1. First", "1. First\n2. "], ["- First", "- First\n- "], ["  * First", "  * First\n  * "], ["- [x] Done", "- [x] Done\n- [ ] "], ["- ", ""]]) {
    const action = promptEnterAction(input(from, { shiftKey: true }));
    assert.equal(action.insertion.value, to); assert.equal(action.insertion.caret, to.length);
  }
});
