import type { WorkspaceGraphIndex } from "./index.js";
import type { GraphEdgeV1, GraphNodeV1 } from "./types.js";

export type GraphSelection = { nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; summary: string; omitted?: boolean };

const confidencePenalty = { extracted: 0, inferred: 20, ambiguous: 60 } as const;

function normalized(value: string): string { return value.trim().toLocaleLowerCase(); }

export function matchingNodes(index: WorkspaceGraphIndex, rawQuery: string, limit = 20): GraphNodeV1[] {
  const query = normalized(rawQuery);
  const terms = query.split(/[^a-z0-9_./:-]+/).filter(Boolean);
  return index.graph.nodes
    .map((node) => {
      const id = normalized(node.id);
      const label = normalized(node.label);
      const qualified = normalized(node.qualifiedName ?? "");
      const file = normalized(node.location?.path ?? "");
      let score = id === query || qualified === query ? 1000 : label === query ? 900 : file === query ? 850 : 0;
      if (!score && (qualified.includes(query) || label.includes(query))) score = 600;
      if (!score && file.includes(query)) score = 500;
      score += terms.reduce((sum, term) => sum + ([id, label, qualified, file].some((value) => value.includes(term)) ? 25 : 0), 0);
      return { node, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, Math.max(1, limit))
    .map(({ node }) => node);
}

export function traverse(index: WorkspaceGraphIndex, seeds: readonly GraphNodeV1[], depth: number, direction: "incoming" | "outgoing" | "both", nodeLimit: number): GraphSelection {
  const nodes = new Map(seeds.map((node) => [node.id, node]));
  const edges = new Map<string, GraphEdgeV1>();
  let frontier = seeds.map((node) => node.id).sort();
  let omitted = false;
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      const candidates = [
        ...(direction !== "outgoing" ? index.incoming.get(nodeId) ?? [] : []),
        ...(direction !== "incoming" ? index.outgoing.get(nodeId) ?? [] : []),
      ].sort((a, b) => confidencePenalty[a.confidence] - confidencePenalty[b.confidence] || a.id.localeCompare(b.id));
      for (const edge of candidates) {
        if (edge.confidence === "ambiguous") continue;
        const otherId = edge.from === nodeId ? edge.to : edge.from;
        const other = index.nodesById.get(otherId);
        if (!other) continue;
        if (!nodes.has(otherId) && nodes.size >= nodeLimit) { omitted = true; continue; }
        nodes.set(otherId, other);
        edges.set(edge.id, edge);
        if (!frontier.includes(otherId)) next.add(otherId);
      }
    }
    frontier = [...next].sort();
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), summary: "", omitted };
}

export function queryGraph(index: WorkspaceGraphIndex, query: string, depth = 1, limit = 20): GraphSelection {
  const seeds = matchingNodes(index, query, Math.min(limit, 8));
  const result = traverse(index, seeds, depth, "both", limit);
  return { ...result, summary: seeds.length ? `Found ${seeds.length} matching seed node(s) and ${result.nodes.length - seeds.length} connected node(s).` : `No graph nodes matched ${JSON.stringify(query)}. Verify with search/read.` };
}
