import type { GraphEdgeV1, GraphNodeV1, WorkspaceGraphV1 } from "./types.js";

export type WorkspaceGraphIndex = {
  graph: WorkspaceGraphV1;
  nodesById: ReadonlyMap<string, GraphNodeV1>;
  outgoing: ReadonlyMap<string, readonly GraphEdgeV1[]>;
  incoming: ReadonlyMap<string, readonly GraphEdgeV1[]>;
  nodesByFile: ReadonlyMap<string, readonly GraphNodeV1[]>;
};

function append<T>(map: Map<string, T[]>, key: string, value: T) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function buildWorkspaceGraphIndex(graph: WorkspaceGraphV1): WorkspaceGraphIndex {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdgeV1[]>();
  const incoming = new Map<string, GraphEdgeV1[]>();
  const nodesByFile = new Map<string, GraphNodeV1[]>();
  for (const node of graph.nodes) if (node.location) append(nodesByFile, node.location.path, node);
  for (const edge of graph.edges) {
    append(outgoing, edge.from, edge);
    append(incoming, edge.to, edge);
  }
  const edgeOrder = (a: GraphEdgeV1, b: GraphEdgeV1) => a.id.localeCompare(b.id);
  for (const values of outgoing.values()) values.sort(edgeOrder);
  for (const values of incoming.values()) values.sort(edgeOrder);
  for (const values of nodesByFile.values()) values.sort((a, b) => a.id.localeCompare(b.id));
  return { graph, nodesById, outgoing, incoming, nodesByFile };
}
