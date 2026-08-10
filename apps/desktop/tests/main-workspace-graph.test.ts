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

test("workspace graph is a togglable tool and defaults on", () => {
  assert.equal(tools.isRunnerToolId("workspace_graph"), true);
  assert.equal(tools.defaultToolSettings().workspace_graph, true);
  assert.ok(tools.enabledToolsFromSettings({}).includes("workspace_graph"));
});

test("the artifact path stays inside the workspace and under the excluded index directory", () => {
  const workspace = temporaryWorkspace();
  const artifact = indexer.workspaceGraphArtifactPath(workspace);
  assert.equal(path.isAbsolute(artifact), true);
  assert.equal(path.relative(workspace, artifact).startsWith(".."), false);
  assert.equal(policy.isGeneratedRuntimePath(indexer.workspaceGraphArtifactRelativePath), true);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("no artifact means no runner config fragment, so the tool cannot admit", () => {
  const workspace = temporaryWorkspace();
  assert.equal(indexer.workspaceGraphArtifactExists(workspace), false);
  assert.equal(indexer.workspaceGraphRunnerConfig(workspace), undefined);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("the config assertion rejects enabling the tool without an artifact", () => {
  const workspace = temporaryWorkspace();
  const base = {
    taskId: "task-1",
    cwd: workspace,
    permissionMode: "normal",
    enabledTools: ["read", "workspace_graph"],
    lspServers: [],
  };
  assert.throws(
    () => policy.assertUmbraticRunnerConfig({ ...base }, {}),
    /workspace graph tool must not be enabled without an artifact/,
  );
  assert.throws(
    () =>
      policy.assertUmbraticRunnerConfig(
        { ...base, workspaceGraph: { artifactPath: path.join(os.tmpdir(), "elsewhere", "graph.json") } },
        {},
      ),
    /workspace graph artifact must live inside the workspace/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});
