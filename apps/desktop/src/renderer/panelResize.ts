import type React from "react";

/** Keep the element, not React's event.currentTarget, across native callbacks. */
export function trackPanelResize(
  event: React.PointerEvent<HTMLDivElement>,
  onMove: (clientX: number) => void,
  onStop: () => void,
): void {
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("isResizing");
  const stop = () => {
    document.body.classList.remove("isResizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeEventListener("lostpointercapture", stop);
    onStop();
  };
  const move = (next: PointerEvent) => {
    if (!next.isPrimary || (next.buttons & 1) !== 1) {
      stop();
      return;
    }
    onMove(next.clientX);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop, { once: true });
  handle.addEventListener("pointercancel", stop, { once: true });
  handle.addEventListener("lostpointercapture", stop, { once: true });
}
