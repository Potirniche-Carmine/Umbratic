import type { GraphSelection } from "./query.js";
import type { GraphFreshness, WorkspaceGraphResult, WorkspaceGraphV1 } from "./types.js";

export const graphOutputLimits = { nodes: 40, edges: 80, bytes: 48 * 1024 } as const;

export function resultEnvelope(graph: WorkspaceGraphV1, freshness: GraphFreshness, selection: GraphSelection, warnings: string[] = []): WorkspaceGraphResult {
  let nodes = selection.nodes.slice(0, graphOutputLimits.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  let edges = selection.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).slice(0, graphOutputLimits.edges);
  let omitted = !!selection.omitted || nodes.length < selection.nodes.length || edges.length < selection.edges.length;
  let result: WorkspaceGraphResult = {
    schemaVersion: 1, graphRevision: graph.revision, freshness, generatedAt: new Date().toISOString(),
    summary: selection.summary, nodes, edges,
    ...(omitted ? { truncation: { nodeLimit: graphOutputLimits.nodes, edgeLimit: graphOutputLimits.edges, omitted: true } } : {}),
    warnings,
  };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > graphOutputLimits.bytes && (edges.length || nodes.length > 1)) {
    omitted = true;
    if (edges.length > nodes.length) edges = edges.slice(0, -1); else nodes = nodes.slice(0, -1);
    const retained = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => retained.has(edge.from) && retained.has(edge.to));
    result = { ...result, nodes, edges, truncation: { nodeLimit: graphOutputLimits.nodes, edgeLimit: graphOutputLimits.edges, omitted } };
  }
  return result;
}
