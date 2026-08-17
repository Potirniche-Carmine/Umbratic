import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const indexer = loadTypeScriptModule(new URL("../src/main/indexerService.ts", import.meta.url));
const policy = loadTypeScriptModule(new URL("../src/main/policy.ts", import.meta.url));
const tools = loadTypeScriptModule(new URL("../src/main/toolSettings.ts", import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function temporaryWorkspace(): string {
  // realpath first: pathInside compares resolved paths, and on Windows the
  // temp directory is usually reached through a short-name symlink.
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "umbratic-graph-"));
}

/**
 * The consistency guard the plan's audit found missing: a tool can exist on one
 * side of the desktop/runner boundary only with an explicit decision on the
 * other. The runner's larger catalog set (apply_patch, read_skill, …) is
 * intentionally not user-toggleable, which this documents.
 */
test("every desktop runner tool id is a tool the runner knows about", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "packages/runner/src/config.rs"), "utf8");
  const block = source.match(/RUNNER_TOOL_NAMES: \[&str; \d+\] = \[([\s\S]*?)\];/);
  assert.ok(block, "RUNNER_TOOL_NAMES must be findable in config.rs");
  const runnerNames = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);

  assert.deepEqual([...tools.runnerToolIds].sort(), [...runnerNames].sort());
});

test("web tools are togglable and default off", () => {
  assert.equal(tools.isRunnerToolId("web_search"), true);
  assert.equal(tools.isRunnerToolId("web_fetch"), true);
  assert.equal(tools.defaultToolSettings().web_search, false);
  assert.equal(tools.defaultToolSettings().web_fetch, false);
  assert.equal(tools.enabledToolsFromSettings({}).includes("web_search"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(tools.enabledToolsFromSettings({ web_search: true, web_fetch: true }).filter((id) => id.startsWith("web_")))),
    ["web_search", "web_fetch"],
  );
});

test("workspace graph is a togglable tool and defaults on", () => {
  assert.equal(tools.isRunnerToolId("workspace_graph"), true);
  assert.equal(tools.defaultToolSettings().workspace_graph, true);
  assert.ok(tools.enabledToolsFromSettings({}).includes("workspace_graph"));
  const shared = fs.readFileSync(new URL("../src/shared/desktopApiTypes.ts", import.meta.url), "utf8");
  const rendererTypes = fs.readFileSync(new URL("../src/renderer/rendererTypes.ts", import.meta.url), "utf8");
  assert.match(shared, /export type RunnerToolId =/);
  assert.match(shared, /"workspace_graph"/);
  assert.doesNotMatch(rendererTypes, /export type RunnerToolId/);
});

/**
 * The index is Umbratic's own derived state. Writing it into the tree being
 * worked on would put a multi-megabyte generated file into the user's diffs,
 * their git status, and their backups.
 */
test("the artifact lives in the app data directory, never in the workspace", () => {
  const workspace = temporaryWorkspace();
  const dataRoot = temporaryWorkspace();
  indexer.setIndexDataRoot(dataRoot);

  const artifact = indexer.workspaceGraphArtifactPath(workspace);
  assert.equal(path.isAbsolute(artifact), true);
  assert.equal(path.relative(dataRoot, artifact).startsWith(".."), false);
  assert.equal(path.relative(workspace, artifact).startsWith(".."), true);

  // Two workspaces never share an index, and one workspace is stable across calls.
  const other = indexer.workspaceGraphArtifactPath(path.join(workspace, "nested"));
  assert.notEqual(artifact, other);
  assert.equal(artifact, indexer.workspaceGraphArtifactPath(workspace));

  indexer.setIndexDataRoot(null);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("no artifact means no runner config fragment, so the tool cannot admit", () => {
  const workspace = temporaryWorkspace();
  const dataRoot = temporaryWorkspace();
  indexer.setIndexDataRoot(dataRoot);
  assert.equal(indexer.workspaceGraphArtifactExists(workspace), false);
  assert.equal(indexer.workspaceGraphRunnerConfig(workspace), undefined);
  indexer.setIndexDataRoot(null);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("the config assertion rejects an artifact outside the Umbratic data directory", () => {
  const workspace = temporaryWorkspace();
  const dataRoot = temporaryWorkspace();
  const base = {
    taskId: "task-1",
    cwd: workspace,
    permissionMode: "normal",
    enabledTools: ["read", "workspace_graph"],
    lspServers: [],
  };
  assert.throws(
    () => policy.assertUmbraticRunnerConfig({ ...base }, {}, dataRoot),
    /workspace graph tool must not be enabled without an artifact/,
  );
  // Inside the user's own tree is the specific mistake this guards against.
  assert.throws(
    () =>
      policy.assertUmbraticRunnerConfig(
        { ...base, workspaceGraph: { artifactPath: path.join(workspace, ".umbratic/index/graph.json") } },
        {},
        dataRoot,
      ),
    /workspace graph artifact must live in the Umbratic data directory/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
