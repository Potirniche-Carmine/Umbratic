export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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

export function scrollElementToBottom(node: HTMLElement, behavior: ScrollBehavior = "auto") {
  const scrollBehavior = behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior;
  const scroll = () => {
    if (scrollBehavior === "auto") {
      node.scrollTop = node.scrollHeight;
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior });
  };
  scroll();
  window.requestAnimationFrame(() => {
    scroll();
  });
}

export function placeElementAtBottom(node: HTMLElement) {
  node.scrollTop = node.scrollHeight;
}
