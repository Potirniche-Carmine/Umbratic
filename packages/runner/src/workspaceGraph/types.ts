export type GraphConfidence = "extracted" | "inferred" | "ambiguous";
export type GraphFreshness = "fresh" | "stale" | "building" | "degraded";

export type GraphSourceLocation = {
  path: string;
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
};

export type GraphNodeV1 = {
  id: string;
  kind: string;
  label: string;
  qualifiedName?: string;
  location?: GraphSourceLocation;
  communityId?: string;
};

export type GraphEdgeV1 = {
  id: string;
  from: string;
  to: string;
  relation: string;
  confidence: GraphConfidence;
  evidence: string;
  source: GraphSourceLocation;
};

export type GraphCommunityV1 = { id: string; label?: string; nodeIds: string[] };

export type WorkspaceGraphV1 = {
  schemaVersion: 1;
  workspaceFingerprint: string;
  revision: string;
  builtAt: string;
  extractor: { id: string; version: string };
  files: Record<string, { hash: string; size: number; language?: string; indexedAt: string }>;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  communities?: GraphCommunityV1[];
};

export type WorkspaceGraphArgs =
  | { action: "summary" }
  | { action: "query"; query: string; depth?: number; limit?: number }
  | { action: "explain"; symbol: string; limit?: number }
  | { action: "path"; from: string; to: string; maxDepth?: number }
  | { action: "affected"; files?: string[]; symbols?: string[]; depth?: number; direction?: "incoming" | "outgoing" | "both" };

export type GraphNodeEvidence = GraphNodeV1;
export type GraphEdgeEvidence = GraphEdgeV1;

export type WorkspaceGraphResult = {
  schemaVersion: 1;
  graphRevision: string;
  freshness: GraphFreshness;
  generatedAt: string;
  summary: string;
  nodes: GraphNodeEvidence[];
  edges: GraphEdgeEvidence[];
  truncation?: { nodeLimit: number; edgeLimit: number; omitted: boolean };
  warnings: string[];
};
