import { normalizedGraphPath } from "./schema.js";
import type { WorkspaceGraphIndex } from "./index.js";
import { matchingNodes, traverse, type GraphSelection } from "./query.js";

export function affectedGraph(index: WorkspaceGraphIndex, input: { files?: string[]; symbols?: string[]; depth?: number; direction?: "incoming" | "outgoing" | "both" }): GraphSelection {
  const seeds = new Map();
  for (const file of input.files ?? []) {
    const normalized = normalizedGraphPath(file, "affected file");
    for (const node of index.nodesByFile.get(normalized) ?? []) seeds.set(node.id, node);
    const fileNode = index.nodesById.get(`file:${normalized}`);
    if (fileNode) seeds.set(fileNode.id, fileNode);
  }
  for (const symbol of input.symbols ?? []) for (const node of matchingNodes(index, symbol, 4)) seeds.set(node.id, node);
  const selection = traverse(index, [...seeds.values()], input.depth ?? 2, input.direction ?? "incoming", 40);
  return { ...selection, summary: seeds.size ? `Projected impact from ${seeds.size} changed graph node(s) to ${selection.nodes.length - seeds.size} connected node(s).` : "No changed files or symbols matched graph nodes. Verify with search/read." };
}
