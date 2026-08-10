import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Owns the workspace graph artifact: where it lives, when it is rebuilt, and
 * whether the runner is told about it.
 *
 * Every failure here degrades to exactly today's behaviour. Until an artifact
 * exists the runner config carries no `workspaceGraph` key, the tool's service
 * gate never opens, and the model works from search/find/read as before. A
 * crashed indexer costs the feature, never the session.
 */

/** Relative to the workspace root, and excluded from search/find/ls by policy. */
export const workspaceGraphArtifactRelativePath = ".umbratic/index/graph.json";

const buildTimeoutMs = 120_000;
const updateTimeoutMs = 30_000;
const analyzeTimeoutMs = 30_000;

/** One build per workspace at a time; a second request coalesces onto the first. */
const inFlight = new Map<string, Promise<boolean>>();

function nativeIndexerFilename(): string {
  return process.platform === "win32" ? "umbratic-code-index.exe" : "umbratic-code-index";
}

/** Mirrors `pdfInspectorBinaryPath`: packaged resources first, dev target second. */
export function codeIndexBinaryPath(): string | null {
  const filename = nativeIndexerFilename();
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "code-index", filename));
  candidates.push(path.resolve(__dirname, "../../../../target/release", filename));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* Keep looking. */
    }
  }
  return null;
}

export function workspaceGraphArtifactPath(workspacePath: string): string {
  return path.join(workspacePath, ...workspaceGraphArtifactRelativePath.split("/"));
}

export function workspaceGraphArtifactExists(workspacePath: string): boolean {
  try {
    return fs.statSync(workspaceGraphArtifactPath(workspacePath)).isFile();
  } catch {
    return false;
  }
}

function runIndexer(args: string[], timeoutMs: number): Promise<boolean> {
  const binary = codeIndexBinaryPath();
  if (!binary) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      // No shell, no inherited stdio, a hard timeout, and a bounded buffer: the
      // indexer is a one-shot helper, not a long-lived service.
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

/**
 * Builds or incrementally updates the artifact. `update` rebuilds fully by
 * itself whenever its recorded revision no longer resolves, so callers never
 * have to decide which one they need.
 */
export function refreshWorkspaceGraph(workspacePath: string): Promise<boolean> {
  const existing = inFlight.get(workspacePath);
  if (existing) return existing;
  const artifact = workspaceGraphArtifactPath(workspacePath);
  const command = workspaceGraphArtifactExists(workspacePath) ? "update" : "build";
  const started = runIndexer(
    [command, "--workspace", workspacePath, "--out", artifact],
    command === "build" ? buildTimeoutMs : updateTimeoutMs,
  ).finally(() => inFlight.delete(workspacePath));
  inFlight.set(workspacePath, started);
  return started;
}

/**
 * Writes `insights.json` beside the graph for the diff against `base`. The
 * patch hash comes from the desktop so the insights describe exactly the diff
 * the review panel is showing rather than a second diff computed here.
 */
export function analyzeWorkspaceChanges(
  workspacePath: string,
  base: string,
  patchHash: string,
): Promise<boolean> {
  if (!workspaceGraphArtifactExists(workspacePath)) return Promise.resolve(false);
  return runIndexer(
    [
      "analyze",
      "--workspace",
      workspacePath,
      "--out",
      workspaceGraphArtifactPath(workspacePath),
      "--base",
      base,
      "--patch-hash",
      patchHash,
    ],
    analyzeTimeoutMs,
  );
}

export type WorkspaceGraphConfig = { artifactPath: string };

/**
 * The runner config fragment. Absent — not empty — when there is no artifact,
 * because an artifact path that points at nothing would open the tool's gate
 * on a graph that cannot load.
 */
export function workspaceGraphRunnerConfig(workspacePath: string): WorkspaceGraphConfig | undefined {
  if (!codeIndexBinaryPath() || !workspaceGraphArtifactExists(workspacePath)) return undefined;
  return { artifactPath: workspaceGraphArtifactPath(workspacePath) };
}
