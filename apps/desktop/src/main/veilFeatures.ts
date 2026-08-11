/**
 * Capability discovery against Veil.
 *
 * Veil ships on its own cadence, so this process routinely talks to a server
 * older or newer than itself. Discovery is by feature name, never by version:
 * a name answers the only question a caller has — "can I send this?" — while a
 * version number would have to be translated through a table that goes stale.
 *
 * Two rules the root AGENTS.md states and this module exists to enforce:
 * a missing `features` field means no features, not "assume yes"; and any field
 * with security meaning must be gated on a name here before it is sent, because
 * a silent no-op on an older server is a security regression, not degradation.
 */

/** Feature names this build knows how to cooperate on. */
export const veilFeature = {
  toolsBoundsOnly: "tools.bounds_only",
  harnessBucketHint: "chat.harness_bucket_hint",
  tolerantBody: "chat.tolerant_body",
  telemetryOpenVocabulary: "telemetry.open_vocabulary",
  orientPreviousResponse: "orient.previous_response",
  /**
   * The server retrieves company documents for the request's route and injects
   * them as cited untrusted context. Nothing is sent to earn this: it is
   * entirely server-side, and the name exists so a desktop can say that answers
   * may cite company documents on this server and stay silent on one where they
   * cannot.
   */
  rag: "rag",
  /** `GET /api/models` exists and lists what this server routes to. */
  modelsList: "models.list",
  /**
   * Chat bodies may name a model. Security-semantic: a server without a
   * registry refuses `model` outright rather than ignoring it, so this name
   * must be present before the field is ever sent.
   */
  modelSelection: "chat.model_selection",
  /** Chat bodies may carry a `thinking` directive. */
  thinkingToggle: "chat.thinking_toggle",
} as const;

export type VeilFeature = (typeof veilFeature)[keyof typeof veilFeature];

/**
 * A server that advertises nothing is treated as advertising nothing — the
 * absent-field case and the empty-list case are deliberately identical.
 */
export function parseVeilFeatures(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const raw = (payload as Record<string, unknown>).features;
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function supportsVeilFeature(features: readonly string[], feature: VeilFeature): boolean {
  return features.includes(feature);
}

/**
 * What the last health check found. One connected Veil at a time, so one list.
 * It starts empty, which means a caller that gates correctly does nothing until
 * a health check has actually answered.
 */
let connectedFeatures: string[] = [];

export function recordVeilFeatures(features: readonly string[] | undefined): void {
  connectedFeatures = features ? [...features] : [];
}

export function connectedVeilSupports(feature: VeilFeature): boolean {
  return supportsVeilFeature(connectedFeatures, feature);
}

export function connectedVeilFeatures(): string[] {
  return [...connectedFeatures];
}

/**
 * The message shown when a feature the user asked for is not on this server.
 * A 404 on a route is the same condition as an unadvertised name — the server
 * cannot do it — so both land here and read the same way.
 */
export function veilFeatureUnavailableMessage(feature: VeilFeature): string {
  return `This server does not support ${feature}. Update the server to use it.`;
}
