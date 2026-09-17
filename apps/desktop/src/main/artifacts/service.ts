/**
 * The desktop half of the artifact round trip.
 *
 * The runner asks for a job over the event stream and waits; this runs it and
 * replies. Two things make that worth a module of its own rather than a branch
 * in the event adapter.
 *
 * The first is the worker. Document code parses zips and XML from wherever the
 * user got them, so it runs in a utility process that is killed on timeout,
 * never shares the main process's heap, and is restarted for each job. The
 * second is transport. In server mode the runner is on another machine, and the
 * file it named lives there — so the bytes are pulled here, built here, and
 * pushed back, with the whole trip counted against the job's timeout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utilityProcess } from "electron";

import type { ArtifactRequest, ArtifactResponse } from "./worker/engine.js";

/** Where the compiled worker lands relative to this module. */
function workerPath(): string {
  return path.resolve(__dirname, "worker", "index.js");
}

/**
 * Whether this build can answer artifact jobs at all.
 *
 * The runner asks before it advertises the tool, which is what keeps a model
 * from being offered a document builder that is not there. It is a file check
 * rather than a capability probe because the worker ships inside the app: if it
 * is missing, the build is broken, not the host.
 */
export function artifactEngineAvailable(): boolean {
  try {
    return fs.existsSync(workerPath());
  } catch {
    return false;
  }
}

export type ArtifactJob = {
  artifactId: string;
  action: "inspect" | "create" | "edit";
  format: string;
  /** Workspace-relative, as the runner resolved them. */
  path?: string;
  out?: string;
  /** Absolute on whichever machine the workspace is. */
  absolutePath?: string;
  absoluteOut?: string;
  templatePath?: string;
  spec?: unknown;
  ops?: unknown[];
  options?: Record<string, unknown>;
  timeoutMs: number;
};

export type ArtifactTransport = {
  /** The workspace root on the machine that runs the job. */
  workspaceRoot: string;
  /** Reads a file the job named. Local mode reads the disk. */
  read(absolutePath: string): Promise<Buffer>;
  /** Installs the finished bytes at the destination, atomically. */
  write(absolutePath: string, bytes: Buffer): Promise<void>;
  /** Cleans up whatever staging the transport used. */
  dispose(): Promise<void>;
};

export function localTransport(workspaceRoot: string): ArtifactTransport {
  return {
    workspaceRoot,
    async read(absolutePath) {
      return fs.promises.readFile(absolutePath);
    },
    async write(absolutePath, bytes) {
      // The worker already wrote atomically when it ran against this same
      // filesystem, so this path only runs when a job was staged elsewhere.
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      const staged = `${absolutePath}.umbratic-incoming`;
      await fs.promises.writeFile(staged, bytes);
      await fs.promises.rename(staged, absolutePath);
    },
    async dispose() {
      // Nothing was staged.
    },
  };
}

/**
 * Runs a job whose files live on another machine.
 *
 * Input is pulled into a scratch directory here, the job is rewritten to point
 * at the local copies, and the result is pushed back. The file is briefly on
 * this laptop and nowhere else; it does not pass through any service.
 */
export function remoteTransport(options: {
  pull(absolutePath: string): Promise<Buffer>;
  push(absolutePath: string, bytes: Buffer): Promise<void>;
}): ArtifactTransport {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-"));
  return {
    workspaceRoot: scratch,
    async read(absolutePath) {
      return options.pull(absolutePath);
    },
    async write(absolutePath, bytes) {
      await options.push(absolutePath, bytes);
    },
    async dispose() {
      await fs.promises.rm(scratch, { recursive: true, force: true });
    },
  };
}

/**
 * Runs one job and returns the reply the runner is waiting for.
 *
 * Every failure becomes a result rather than a throw: the runner has parked a
 * oneshot on this answer, and an exception here would leave it to time out with
 * a less useful message than the one we already have.
 */
export async function runArtifactJob(
  job: ArtifactJob,
  transport: ArtifactTransport,
): Promise<ArtifactResponse> {
  try {
    const request: ArtifactRequest = {
      action: job.action,
      format: job.format,
      workspaceRoot: transport.workspaceRoot,
      ...(job.path ? { path: job.path } : {}),
      ...(job.out ? { out: job.out } : {}),
      ...(job.spec !== undefined ? { spec: job.spec } : {}),
      ...(job.ops ? { ops: job.ops } : {}),
      ...(job.options ? { options: job.options } : {}),
    };

    // Inputs are staged first so the worker never reaches across a network.
    if (job.absolutePath) {
      request.absolutePath = await stageInput(job.absolutePath, transport);
    }
    if (job.templatePath) {
      await stageInput(job.templatePath, transport);
    }
    if (job.absoluteOut) {
      request.absoluteOut = stageOutput(job.absoluteOut, transport);
    }

    const response = await runInWorker(request, job.timeoutMs);
    if (response.ok && job.absoluteOut && request.absoluteOut !== job.absoluteOut) {
      // The worker wrote to the staging copy; the real destination is elsewhere.
      await transport.write(job.absoluteOut, await fs.promises.readFile(request.absoluteOut!));
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      kind: "runtime",
      errors: [{ path: "", message: String(error instanceof Error ? error.message : error) }],
    };
  } finally {
    await transport.dispose().catch(() => undefined);
  }
}

async function stageInput(absolutePath: string, transport: ArtifactTransport): Promise<string> {
  // Local mode stages nothing: the path the runner resolved is already a path
  // this process can open, and copying it would only add a way to diverge.
  if (fs.existsSync(absolutePath)) return absolutePath;
  const bytes = await transport.read(absolutePath);
  const local = path.join(transport.workspaceRoot, path.basename(absolutePath));
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  await fs.promises.writeFile(local, bytes);
  return local;
}

function stageOutput(absoluteOut: string, transport: ArtifactTransport): string {
  const directory = path.dirname(absoluteOut);
  // A destination whose parent this process can see is written directly.
  if (fs.existsSync(directory) || fs.existsSync(path.dirname(directory))) return absoluteOut;
  return path.join(transport.workspaceRoot, path.basename(absoluteOut));
}

/**
 * Forks the worker, sends the job, and waits.
 *
 * The process is created per job and killed on timeout. A worker that hangs on
 * a malformed zip therefore costs one job rather than the session, and nothing
 * it allocated survives into the next one.
 */
export function runInWorker(request: ArtifactRequest, timeoutMs: number): Promise<ArtifactResponse> {
  const worker = workerPath();
  if (!fs.existsSync(worker) || typeof utilityProcess?.fork !== "function") {
    return Promise.resolve({
      ok: false,
      kind: "runtime",
      errors: [{ path: "", message: "the document engine is not present in this build" }],
    });
  }
  return new Promise((resolve) => {
    const child = utilityProcess.fork(worker, [], {
      cwd: path.dirname(worker),
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: "umbratic-artifacts",
    });
    let settled = false;
    const finish = (response: ArtifactResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("spawn");
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve(response);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        kind: "runtime",
        errors: [
          {
            path: "",
            message: `the document engine did not finish within ${Math.round(timeoutMs / 1000)} seconds; nothing was written`,
          },
        ],
      });
    }, timeoutMs);

    // The worker's stdout and stderr are drained but not forwarded: a document
    // engine's diagnostics are not the user's business, and an undrained pipe
    // eventually blocks the child.
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.once("message", (message: unknown) => {
      finish(isResponse(message) ? message : {
        ok: false,
        kind: "runtime",
        errors: [{ path: "", message: "the document engine returned a result that could not be read" }],
      });
    });
    child.once("error", (error: unknown) =>
      finish({
        ok: false,
        kind: "runtime",
        errors: [{ path: "", message: String(error instanceof Error ? error.message : error) }],
      }),
    );
    child.once("exit", () =>
      finish({
        ok: false,
        kind: "runtime",
        errors: [{ path: "", message: "the document engine stopped before it answered; nothing was written" }],
      }),
    );
    // Electron drops messages sent before the utility process has spawned.
    child.once("spawn", () => {
      try {
        child.postMessage(request);
      } catch {
        finish({
          ok: false,
          kind: "runtime",
          errors: [{ path: "", message: "the document engine could not receive the job" }],
        });
      }
    });
  });
}

function isResponse(value: unknown): value is ArtifactResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) return typeof candidate.path === "string";
  return candidate.ok === false && Array.isArray(candidate.errors);
}
