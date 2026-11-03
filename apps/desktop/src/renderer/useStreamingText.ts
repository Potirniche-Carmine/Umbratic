import { useLayoutEffect, useRef, useState } from "react";
import { advanceStreamingText } from "./streamingText";

/** Spread transport bursts over display frames. Corrections and completion are
 * immediate; the source text stays authoritative, with at most 64ms tail lag. */
export function useStreamingText(content: string, streaming: boolean): string {
  const [display, setDisplay] = useState(content);
  const shown = useRef(content);
  const target = useRef(content);
  const frame = useRef(0);
  const deadline = useRef(0);
  const previous = useRef(0);
  useLayoutEffect(() => {
    target.current = content;
    if (!streaming || !content.startsWith(shown.current) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelAnimationFrame(frame.current); frame.current = 0;
      shown.current = content; setDisplay(content); return;
    }
    deadline.current = performance.now() + 64;
    if (frame.current || shown.current === content) return;
    previous.current = performance.now();
    const tick = (now: number) => {
      shown.current = advanceStreamingText(shown.current, target.current, Math.min(1, (now - previous.current) / Math.max(1, deadline.current - previous.current)));
      previous.current = now; setDisplay(shown.current);
      frame.current = shown.current !== target.current ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [content, streaming]);
  useLayoutEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);
  return !streaming || !content.startsWith(display) ? content : display;
}
