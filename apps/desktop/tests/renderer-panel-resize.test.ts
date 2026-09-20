import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("both panel drags release listeners after React clears currentTarget or capture is lost", () => {
  for (const end of ["pointerup", "pointercancel", "lostpointercapture", "buttons-released"]) {
    const classes = new Set();
    const { trackPanelResize } = loadTypeScriptModule(new URL("../src/renderer/panelResize.ts", import.meta.url), {
      globals: { document: { body: { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) } } } },
    });
    const handle = Object.assign(new EventTarget(), { setPointerCapture() {} });
    const event = { isPrimary: true, button: 0, pointerId: 1, currentTarget: handle, preventDefault() {} };
    const moved = [];
    let stopped = 0;
    trackPanelResize(event, (x) => moved.push(x), () => stopped++);
    event.currentTarget = null;
    handle.dispatchEvent(Object.assign(new Event("pointermove"), { isPrimary: true, buttons: 1, clientX: 320 }));
    assert.deepEqual(moved, [320]);
    if (end === "buttons-released") handle.dispatchEvent(Object.assign(new Event("pointermove"), { isPrimary: true, buttons: 0 }));
    else handle.dispatchEvent(new Event(end));
    assert.equal(stopped, 1, end);
    assert.equal(classes.size, 0);
    for (const name of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) assert.equal(getEventListeners(handle, name).length, 0, name);
    handle.dispatchEvent(new Event("pointerup"));
    assert.equal(stopped, 1);
  }
});
