import type { WorkspaceGraphIndex } from "./index.js";
import { matchingNodes, type GraphSelection } from "./query.js";

export function shortestGraphPath(index: WorkspaceGraphIndex, from: string, to: string, maxDepth = 6): GraphSelection {
  const starts = matchingNodes(index, from, 4);
  const targets = new Set(matchingNodes(index, to, 4).map((node) => node.id));
  if (!starts.length || !targets.size) return { nodes: [], edges: [], summary: "No path found because one or both endpoints did not match graph nodes." };
  const queue = starts.map((node) => ({ id: node.id, edges: [] as string[] }));
  const seen = new Set(queue.map(({ id }) => id));
  while (queue.length) {
    const current = queue.shift()!;
    if (targets.has(current.id)) {
      const edges = current.edges.map((id) => index.graph.edges.find((edge) => edge.id === id)!).filter(Boolean);
      const nodeIds = new Set([current.id, ...edges.flatMap((edge) => [edge.from, edge.to])]);
      return { nodes: [...nodeIds].map((id) => index.nodesById.get(id)!).filter(Boolean), edges, summary: `Found a path with ${edges.length} edge(s).` };
    }
    if (current.edges.length >= maxDepth) continue;
    for (const edge of index.outgoing.get(current.id) ?? []) {
      if (edge.confidence === "ambiguous" || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ id: edge.to, edges: [...current.edges, edge.id] });
    }
  }
  return { nodes: [], edges: [], summary: `No directed path found within depth ${maxDepth}.` };
}
