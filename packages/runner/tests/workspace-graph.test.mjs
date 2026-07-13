import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const cache = new Map();
const fixturePath = new URL("./fixtures/workspace-graph/graph-v1.json", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const { parseWorkspaceGraph } = loadTypeScriptModule(new URL("../src/workspaceGraph/schema.ts", import.meta.url).pathname, { cache });
const { buildWorkspaceGraphIndex } = loadTypeScriptModule(new URL("../src/workspaceGraph/index.ts", import.meta.url).pathname, { cache });
const { queryGraph } = loadTypeScriptModule(new URL("../src/workspaceGraph/query.ts", import.meta.url).pathname, { cache });
const { shortestGraphPath } = loadTypeScriptModule(new URL("../src/workspaceGraph/path.ts", import.meta.url).pathname, { cache });
const { affectedGraph } = loadTypeScriptModule(new URL("../src/workspaceGraph/affected.ts", import.meta.url).pathname, { cache });
const { WorkspaceGraphService } = loadTypeScriptModule(new URL("../src/workspaceGraph/service.ts", import.meta.url).pathname, { cache });
const { WorkspaceGraphStore } = loadTypeScriptModule(new URL("../src/workspaceGraph/store.ts", import.meta.url).pathname, { cache });
const { buildToolPlan } = loadTypeScriptModule(new URL("../src/tools/planner.ts", import.meta.url).pathname, { cache });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("version 1 fixtures validate and index deterministically", () => {
  const first = parseWorkspaceGraph(fixture);
  const second = parseWorkspaceGraph(fixture);
  assert.deepEqual(plain(first), plain(second));
  assert.deepEqual(plain(first.nodes.map((node) => node.id)), [...first.nodes.map((node) => node.id)].sort());
  assert.equal(buildWorkspaceGraphIndex(first).outgoing.get("symbol:src/service.ts:function:createUser:2").length, 1);
});

test("schema rejects unknown versions, absolute paths, dangling edges, and control-character labels", () => {
  assert.throws(() => parseWorkspaceGraph({ ...fixture, schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => parseWorkspaceGraph({ ...fixture, files: { "C:/secret.ts": fixture.files["src/store.ts"] } }), /workspace-relative/);
  assert.throws(() => parseWorkspaceGraph({ ...fixture, edges: [{ ...fixture.edges[0], to: "missing" }] }), /unknown node/);
  const sanitized = parseWorkspaceGraph({ ...fixture, nodes: fixture.nodes.map((node, index) => index ? node : { ...node, label: "safe\u0000label" }) });
  assert.equal(sanitized.nodes.some((node) => node.label === "safelabel"), true);
});

test("query, path, and affected traversal return stable source-backed evidence", () => {
  const index = buildWorkspaceGraphIndex(parseWorkspaceGraph(fixture));
  const query = queryGraph(index, "createUser", 1, 20);
  assert.equal(query.nodes.some((node) => node.label === "save"), true);
  assert.equal(query.edges[0].confidence, "extracted");
  assert.equal(query.edges[0].source.path, "src/service.ts");
  assert.deepEqual(plain(shortestGraphPath(index, "createUser", "save").edges.map((edge) => edge.id)), ["edge:createUser-calls-save"]);
  const affected = affectedGraph(index, { files: ["src/store.ts"], depth: 2, direction: "incoming" });
  assert.equal(affected.nodes.some((node) => node.label === "createUser"), true);
});

test("store writes atomically and rejects oversized artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-graph-store-"));
  const artifact = path.join(root, "graph.json");
  const store = new WorkspaceGraphStore(artifact);
  store.save(fixture);
  assert.equal(store.load().revision, "fixture-revision-1");
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  assert.throws(() => new WorkspaceGraphStore(artifact, 10).load(), /exceeds/);
});

test("service fails closed for mismatched workspaces and preserves graph fallback warnings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-graph-service-"));
  const artifact = path.join(root, "graph.json");
  fs.writeFileSync(artifact, JSON.stringify(fixture));
  const matched = new WorkspaceGraphService(root, new WorkspaceGraphStore(artifact), "fixture-workspace").query({ action: "query", query: "save" });
  assert.equal(matched.freshness, "stale");
  assert.match(matched.warnings[0], /missing|changed/);
  assert.equal(matched.nodes[0].location.path, "src/store.ts");
  assert.ok(Buffer.byteLength(JSON.stringify(matched)) <= 48 * 1024);
  const mismatched = new WorkspaceGraphService(root, new WorkspaceGraphStore(artifact), "another-workspace").query({ action: "summary" });
  assert.equal(mismatched.freshness, "degraded");
  assert.match(mismatched.summary, /search\/read/);
  assert.match(mismatched.warnings[0], /different workspace/);
});

test("workspace_graph is advertised and executable only when its session service is configured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-graph-tool-"));
  const artifact = path.join(root, "graph.json");
  fs.writeFileSync(artifact, JSON.stringify(fixture));
  const workspaceGraph = new WorkspaceGraphService(root, new WorkspaceGraphStore(artifact), "fixture-workspace");
  const withoutGraph = buildToolPlan({ enabledTools: ["read", "workspace_graph"] });
  assert.deepEqual(plain(withoutGraph.modelSpecs.map((spec) => spec.function.name)), ["read"]);
  const plan = buildToolPlan({ enabledTools: ["read", "workspace_graph"], includeWorkspaceGraph: true, providerParallelToolCalls: true });
  assert.deepEqual(plain(plan.modelSpecs.map((spec) => spec.function.name)), ["read", "workspace_graph"]);
  assert.equal(plan.parallelToolCalls, true);
  const result = await plan.registry.dispatch({
    taskId: "graph-test", cwd: root, permissionMode: "bypass", enabledTools: ["read", "workspace_graph"], workspaceGraph,
    signal: new AbortController().signal, askPermission: async () => "allow", emitToolOutput() {},
  }, () => undefined, {
    id: "graph-call", name: { name: "workspace_graph" }, payload: { kind: "function", arguments: { action: "path", from: "createUser", to: "save" } }, index: 0,
  });
  assert.equal(result.status, "success");
  const output = JSON.parse(result.content[0].text);
  assert.deepEqual(plain(output.edges.map((edge) => edge.id)), ["edge:createUser-calls-save"]);
});
