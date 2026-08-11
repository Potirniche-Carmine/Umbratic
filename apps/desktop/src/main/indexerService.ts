import { execFile } from "node:child_process";
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import { workspaceIndexDirectory } from "./appPaths";

/**
 * Owns the workspace graph artifact: where it lives, when it is rebuilt, and
 * whether the runner is told about it.
 *
 * The artifact lives under the app's data directory, keyed by workspace path —
 * never inside the workspace. It is derived state Umbratic owns, and a
 * generated file in the user's tree shows up in their diffs and their backups
 * and makes every project gitignore something it never asked for.
 *
 * Every failure here degrades to exactly today's behaviour. Until an artifact
 * exists the runner config carries no `workspaceGraph` key, the tool's service
 * gate never opens, and the model works from search/find/read as before. A
 * crashed indexer costs the feature, never the session.
 */

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

let dataRootOverride: string | null = null;

/**
 * Test seam. Everything else reads the data root from Electron, which is not
 * available when this module is loaded on its own.
 */
export function setIndexDataRoot(root: string | null): void {
  dataRootOverride = root;
}

function indexDataRoot(): string {
  return dataRootOverride ?? app.getPath("userData");
}

export function workspaceGraphArtifactPath(workspacePath: string): string {
  return path.join(workspaceIndexDirectory(indexDataRoot(), workspacePath), "graph.json");
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

export type WorkspaceIndexPhase = "started" | "finished";

/** Reports the first build of a workspace so the UI can show it happening. */
export type WorkspaceIndexListener = (event: {
  workspacePath: string;
  phase: WorkspaceIndexPhase;
  ok?: boolean;
}) => void;

let listener: WorkspaceIndexListener | null = null;

export function onWorkspaceIndexProgress(next: WorkspaceIndexListener | null): void {
  listener = next;
}

/**
 * Builds or incrementally updates the artifact. `update` rebuilds fully by
 * itself whenever its recorded revision no longer resolves, so callers never
 * have to decide which one they need.
 *
 * Only the first build is announced. An incremental update after a turn takes
 * a fraction of a second, and a status light that blinks on every turn is
 * noise rather than information.
 */
export function refreshWorkspaceGraph(workspacePath: string): Promise<boolean> {
  const existing = inFlight.get(workspacePath);
  if (existing) return existing;
  const artifact = workspaceGraphArtifactPath(workspacePath);
  const isFirstBuild = !workspaceGraphArtifactExists(workspacePath);
  if (isFirstBuild && codeIndexBinaryPath()) {
    listener?.({ workspacePath, phase: "started" });
  }
  const started = runIndexer(
    [isFirstBuild ? "build" : "update", "--workspace", workspacePath, "--out", artifact],
    isFirstBuild ? buildTimeoutMs : updateTimeoutMs,
  )
    .then((ok) => {
      if (isFirstBuild && codeIndexBinaryPath()) {
        listener?.({ workspacePath, phase: "finished", ok });
      }
      return ok;
    })
    .finally(() => inFlight.delete(workspacePath));
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
