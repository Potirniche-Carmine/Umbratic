export type ReviewSpring = { stiffness: number; damping: number };
/// Opening is an arrival and can afford to settle. Closing is a dismissal: the
/// reader has already decided, and every millisecond after that decision is the
/// panel overstaying. Damping sits just under critical (2√stiffness) in both,
/// which is the shape the panel has always had.
export const reviewOpenSpring: ReviewSpring = { stiffness: 420, damping: 38 };
export const reviewCloseSpring: ReviewSpring = { stiffness: 1400, damping: 72 };
/// Small enough to stay stable at this spring's stiffness however long a frame
/// takes, and bounded so returning from a hidden window does not simulate
/// minutes of motion.
export const reviewSpringStepSeconds = 1 / 240;
export const reviewSpringCatchUpSeconds = 0.25;

/// A critically damped spring, advanced in fixed sub-steps. Integrating a whole
/// frame in one step diverges at this stiffness once a frame reaches 50ms — the
/// panel threw itself off screen, came back further than it started, and never
/// met the rest condition — and clamping the frame whole instead just ran the
/// animation in slow motion under load. Sub-stepping is stable at any frame
/// length and catches up honestly after a stall.
export function reviewSpringStep(
  value: number,
  velocity: number,
  target: number,
  elapsedSeconds: number,
  spring: ReviewSpring = reviewOpenSpring,
): { value: number; velocity: number } {
  let remaining = Math.min(Math.max(elapsedSeconds, 0), reviewSpringCatchUpSeconds);
  let nextValue = value;
  let nextVelocity = velocity;
  while (remaining > 0) {
    const step = Math.min(reviewSpringStepSeconds, remaining);
    remaining -= step;
    nextVelocity += (target - nextValue) * spring.stiffness * step - nextVelocity * spring.damping * step;
    nextValue += nextVelocity * step;
  }
  return { value: nextValue, velocity: nextVelocity };
}
