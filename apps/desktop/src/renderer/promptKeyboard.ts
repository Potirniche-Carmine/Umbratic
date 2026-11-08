import { continueNumberedList, type ComposerTextInsertion } from "./composerText";

export function promptEnterAction(input: { key: string; isComposing?: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; sendOnEnter: boolean; running?: boolean; value: string; start: number; end: number }): { type: "send" | "steer" | "queue" } | { type: "insert"; insertion: ComposerTextInsertion } | null {
  if (input.key !== "Enter" || input.isComposing) return null;
  if (input.running) return { type: input.shiftKey ? "queue" : "steer" };
  if (input.metaKey || input.ctrlKey || input.sendOnEnter && !input.shiftKey) return { type: "send" };
  const numbered = continueNumberedList(input.value, input.start, input.end);
  if (numbered) return { type: "insert", insertion: numbered };
  const lineStart = input.value.lastIndexOf("\n", input.start - 1) + 1;
  const lineEndIndex = input.value.indexOf("\n", input.end);
  const lineEnd = lineEndIndex < 0 ? input.value.length : lineEndIndex;
  const before = input.value.slice(lineStart, input.start);
  const match = before.match(/^(\s*)([-*+])\s+(?:\[[ xX]\]\s+)?/);
  if (!match) return null;
  if (!before.slice(match[0].length).trim() && !input.value.slice(input.end, lineEnd).trim()) return { type: "insert", insertion: { value: input.value.slice(0, lineStart) + input.value.slice(lineEnd), caret: lineStart } };
  const text = `\n${match[1]}${match[2]} ${/\[[ xX]\]/.test(match[0]) ? "[ ] " : ""}`;
  return { type: "insert", insertion: { value: input.value.slice(0, input.start) + text + input.value.slice(input.end), caret: input.start + text.length } };
}
