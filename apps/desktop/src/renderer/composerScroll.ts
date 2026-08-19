export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function elementDistanceFromBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

export function isElementNearBottom(node: HTMLElement, threshold = 72) {
  return elementDistanceFromBottom(node) < threshold;
}

export function isElementAtBottom(node: HTMLElement) {
  return elementDistanceFromBottom(node) < 4;
}

const pendingBottomFollows = new WeakMap<HTMLElement, number>();

/// Keep a streaming view pinned to its bottom, at most once per frame.
///
/// Writing scrollTop forces a layout of the whole transcript to resolve
/// scrollHeight. The composer updates about twenty times a second while a run
/// streams and the old path paid for that twice per update, which in a long
/// chat is enough to stall wheel input against the layout it keeps triggering.
/// Following on the frame instead is invisible — the paint lands at the same
/// time either way — and costs one layout per frame at most.
export function followElementToBottom(node: HTMLElement) {
  if (pendingBottomFollows.has(node)) return;
  pendingBottomFollows.set(
    node,
    window.requestAnimationFrame(() => {
      pendingBottomFollows.delete(node);
      node.scrollTop = node.scrollHeight;
    }),
  );
}

export function placeElementAtBottom(node: HTMLElement) {
  node.scrollTop = node.scrollHeight;
}
