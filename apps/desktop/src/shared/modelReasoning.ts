export type ReasoningEffort = string;

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "on", "low", "medium", "high"];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && value !== "none" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

/**
 * The level a model actually runs at, out of the ones it offers, or null when
 * it offers none.
 *
 * The stored effort is one setting across every model, but each model grades
 * thinking its own way, so the stored level is often not one this model reads.
 * It falls back to a level this model does offer, keeping whether the user
 * wanted thinking at all: someone on "medium" who switches to a model that
 * only knows on and off means on, and taking the first offered level instead
 * would quietly turn their thinking off.
 *
 * Both sides resolve through here — the runtime, to decide what to start the
 * model with, and the menu, to decide which row is checked. Resolving in one
 * place is what keeps the checkmark on the level the model is really using
 * rather than on nothing at all.
 */
export function resolveReasoningEffort(
  offered: readonly ReasoningEffort[] | undefined,
  effort: ReasoningEffort,
): ReasoningEffort | null {
  if (!offered || offered.length === 0) return null;
  if (offered.includes(effort)) return effort;
  const wantsThinking = effort !== "off";
  return offered.find((level) => (level !== "off") === wantsThinking) ?? offered[0];
}

