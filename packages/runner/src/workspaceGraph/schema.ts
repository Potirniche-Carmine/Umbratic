import * as path from "node:path";
import type { GraphConfidence, GraphEdgeV1, GraphNodeV1, GraphSourceLocation, WorkspaceGraphV1 } from "./types.js";

const confidences = new Set<GraphConfidence>(["extracted", "inferred", "ambiguous"]);
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const sanitized = value.replace(controlCharacters, "").trim();
  if (!sanitized || Buffer.byteLength(sanitized, "utf8") > max) throw new Error(`${name} exceeds its size limit`);
  return sanitized;
}

function finiteInteger(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

export function normalizedGraphPath(value: unknown, name = "path"): string {
  const input = text(value, name, 4096).replace(/\\/g, "/");
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || input.split("/").includes("..")) {
    throw new Error(`${name} must be a normalized workspace-relative path`);
  }
  const normalized = path.posix.normalize(input).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized !== input.replace(/^\.\//, "")) {
    throw new Error(`${name} must be a normalized workspace-relative path`);
  }
  return normalized;
}

function location(value: unknown, name: string): GraphSourceLocation {
  const input = record(value, name);
  const startLine = finiteInteger(input.startLine, `${name}.startLine`, 1);
  const endLine = input.endLine === undefined ? undefined : finiteInteger(input.endLine, `${name}.endLine`, startLine);
  return {
    path: normalizedGraphPath(input.path, `${name}.path`),
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(input.startColumn !== undefined ? { startColumn: finiteInteger(input.startColumn, `${name}.startColumn`, 1) } : {}),
    ...(input.endColumn !== undefined ? { endColumn: finiteInteger(input.endColumn, `${name}.endColumn`, 1) } : {}),
  };
}

function node(value: unknown, index: number): GraphNodeV1 {
  const input = record(value, `nodes[${index}]`);
  return {
    id: text(input.id, `nodes[${index}].id`, 2048),
    kind: text(input.kind, `nodes[${index}].kind`, 128),
    label: text(input.label, `nodes[${index}].label`, 2048),
    ...(input.qualifiedName !== undefined ? { qualifiedName: text(input.qualifiedName, `nodes[${index}].qualifiedName`, 2048) } : {}),
    ...(input.location !== undefined ? { location: location(input.location, `nodes[${index}].location`) } : {}),
    ...(input.communityId !== undefined ? { communityId: text(input.communityId, `nodes[${index}].communityId`, 256) } : {}),
  };
}

function edge(value: unknown, index: number): GraphEdgeV1 {
  const input = record(value, `edges[${index}]`);
  const confidence = text(input.confidence, `edges[${index}].confidence`, 32) as GraphConfidence;
  if (!confidences.has(confidence)) throw new Error(`edges[${index}].confidence is unsupported`);
  return {
    id: text(input.id, `edges[${index}].id`, 2048),
    from: text(input.from, `edges[${index}].from`, 2048),
    to: text(input.to, `edges[${index}].to`, 2048),
    relation: text(input.relation, `edges[${index}].relation`, 128),
    confidence,
    evidence: text(input.evidence, `edges[${index}].evidence`, 2048),
    source: location(input.source, `edges[${index}].source`),
  };
}

export function parseWorkspaceGraph(value: unknown): WorkspaceGraphV1 {
  const input = record(value, "workspace graph");
  if (input.schemaVersion !== 1) throw new Error(`Unsupported workspace graph schema version: ${String(input.schemaVersion)}`);
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new Error("workspace graph nodes and edges must be arrays");
  const filesInput = record(input.files, "files");
  const files: WorkspaceGraphV1["files"] = {};
  for (const [rawPath, value] of Object.entries(filesInput).sort(([a], [b]) => a.localeCompare(b))) {
    const filePath = normalizedGraphPath(rawPath, "files key");
    const file = record(value, `files.${filePath}`);
    files[filePath] = {
      hash: text(file.hash, `files.${filePath}.hash`, 128),
      size: finiteInteger(file.size, `files.${filePath}.size`),
      ...(file.language !== undefined ? { language: text(file.language, `files.${filePath}.language`, 64) } : {}),
      indexedAt: text(file.indexedAt, `files.${filePath}.indexedAt`, 64),
    };
  }
  const nodes = input.nodes.map(node);
  const nodeIds = new Set<string>();
  for (const item of nodes) {
    if (nodeIds.has(item.id)) throw new Error(`Duplicate graph node id: ${item.id}`);
    nodeIds.add(item.id);
  }
  const edges = input.edges.map(edge);
  const edgeIds = new Set<string>();
  for (const item of edges) {
    if (edgeIds.has(item.id)) throw new Error(`Duplicate graph edge id: ${item.id}`);
    edgeIds.add(item.id);
    if (!nodeIds.has(item.from) || !nodeIds.has(item.to)) throw new Error(`Graph edge ${item.id} references an unknown node`);
  }
  const extractor = record(input.extractor, "extractor");
  return {
    schemaVersion: 1,
    workspaceFingerprint: text(input.workspaceFingerprint, "workspaceFingerprint", 256),
    revision: text(input.revision, "revision", 256),
    builtAt: text(input.builtAt, "builtAt", 64),
    extractor: { id: text(extractor.id, "extractor.id", 128), version: text(extractor.version, "extractor.version", 128) },
    files,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
