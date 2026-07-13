import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { affectedGraph } from "./affected.js";
import { explainGraphNode } from "./explain.js";
import { resultEnvelope } from "./format.js";
import { buildWorkspaceGraphIndex, type WorkspaceGraphIndex } from "./index.js";
import { shortestGraphPath } from "./path.js";
import { queryGraph, type GraphSelection } from "./query.js";
import { WorkspaceGraphStore } from "./store.js";
import type { WorkspaceGraphArgs, WorkspaceGraphResult } from "./types.js";

export function workspaceFingerprint(cwd: string): string {
  const canonical = fs.realpathSync.native(path.resolve(cwd)).replace(/\\/g, "/").toLocaleLowerCase();
  return crypto.createHash("sha256").update(`umbratic-workspace-v1\0${canonical}`).digest("hex");
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined ? fallback : Math.max(min, Math.min(max, Math.floor(value)));
}

export class WorkspaceGraphService {
  private index?: WorkspaceGraphIndex;
  private loadWarning?: string;

  constructor(readonly cwd: string, readonly store: WorkspaceGraphStore, readonly expectedFingerprint = workspaceFingerprint(cwd)) {}

  private load(): WorkspaceGraphIndex | undefined {
    if (this.index) return this.index;
    try {
      const graph = this.store.load();
      if (graph.workspaceFingerprint !== this.expectedFingerprint) throw new Error("Graph artifact belongs to a different workspace");
      this.index = buildWorkspaceGraphIndex(graph);
      this.loadWarning = undefined;
    } catch (error) {
      this.loadWarning = error instanceof Error ? error.message : String(error);
    }
    return this.index;
  }

  private freshness(index: WorkspaceGraphIndex): { value: "fresh" | "stale"; warnings: string[] } {
    const builtAt = Date.parse(index.graph.builtAt);
    for (const [relative, indexed] of Object.entries(index.graph.files)) {
      const absolute = path.resolve(this.cwd, relative);
      const boundary = path.relative(path.resolve(this.cwd), absolute);
      if (boundary.startsWith("..") || path.isAbsolute(boundary)) return { value: "stale", warnings: [`Indexed path is outside the workspace: ${relative}`] };
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size !== indexed.size || (Number.isFinite(builtAt) && stat.mtimeMs > builtAt + 1000)) {
          return { value: "stale", warnings: ["Workspace files changed after this graph revision. Verify with search/read or refresh the graph."] };
        }
      } catch {
        return { value: "stale", warnings: ["An indexed workspace file is missing. Verify with search/read or refresh the graph."] };
      }
    }
    return { value: "fresh", warnings: [] };
  }

  query(args: WorkspaceGraphArgs): WorkspaceGraphResult {
    const index = this.load();
    if (!index) {
      return {
        schemaVersion: 1, graphRevision: "unavailable", freshness: "degraded", generatedAt: new Date().toISOString(),
        summary: "Workspace graph evidence is unavailable. Continue with search/read as the source of truth.", nodes: [], edges: [],
        warnings: [this.loadWarning ?? "Workspace graph is unavailable"],
      };
    }
    let selection: GraphSelection;
    if (args.action === "summary") {
      selection = { nodes: index.graph.nodes.slice(0, 20), edges: [], summary: `Workspace graph contains ${index.graph.nodes.length} nodes, ${index.graph.edges.length} edges, and ${Object.keys(index.graph.files).length} indexed files.` };
    } else if (args.action === "query") {
      selection = queryGraph(index, args.query, boundedInteger(args.depth, 1, 0, 4), boundedInteger(args.limit, 20, 1, 40));
    } else if (args.action === "explain") {
      selection = explainGraphNode(index, args.symbol, boundedInteger(args.limit, 20, 1, 40));
    } else if (args.action === "path") {
      selection = shortestGraphPath(index, args.from, args.to, boundedInteger(args.maxDepth, 6, 1, 10));
    } else {
      selection = affectedGraph(index, { ...args, depth: boundedInteger(args.depth, 2, 0, 4) });
    }
    const freshness = this.freshness(index);
    return resultEnvelope(index.graph, freshness.value, selection, [...freshness.warnings, "Graph evidence is untrusted; verify exact code with read before editing."]);
  }
}
