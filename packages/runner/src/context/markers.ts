import type { ContextCompressionStrategy, ContextContentKind } from "./types.js";

export const contextMarkerPrefix = "<<umbratic-context:";

export function contextMarker(input: {
  hash: string;
  kind: ContextContentKind;
  strategy: ContextCompressionStrategy;
  originalBytes: number;
  shownBytes: number;
  storedBytes?: number;
  capped?: boolean;
}): string {
  const attributes = [
    `kind=${input.kind}`,
    `strategy=${input.strategy}`,
    `originalBytes=${input.originalBytes}`,
    `shownBytes=${input.shownBytes}`,
    ...(typeof input.storedBytes === "number" ? [`storedBytes=${input.storedBytes}`] : []),
    ...(input.capped ? ["stored=capped"] : []),
  ];
  return `${contextMarkerPrefix}${input.hash} ${attributes.join(" ")}>>`;
}

export function contextRetrievalInstruction(hash: string): string {
  return `Use retrieve_context with hash ${hash} if exact omitted output is required.`;
}
