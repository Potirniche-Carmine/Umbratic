import type { WorkspaceGraphIndex } from "./index.js";
import { matchingNodes, traverse, type GraphSelection } from "./query.js";

export function explainGraphNode(index: WorkspaceGraphIndex, symbol: string, limit = 20): GraphSelection {
  const seeds = matchingNodes(index, symbol, 1);
  const selection = traverse(index, seeds, 1, "both", limit);
  return { ...selection, summary: seeds.length ? `Explained ${seeds[0].label} with ${selection.edges.length} direct relationship(s).` : `No graph symbol matched ${JSON.stringify(symbol)}.` };
}
