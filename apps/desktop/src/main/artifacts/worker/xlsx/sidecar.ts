/**
 * The bridge to the XLSX engine.
 *
 * Spreadsheets are the one format built in Rust rather than in JavaScript, for
 * a reason that is not about speed: a workbook that recalculates is a workbook
 * whose formulas were evaluated, and the crates that read, write, and round-trip
 * xlsx without losing a stranger's charts and conditional formats are Rust ones.
 * Rather than pull that behaviour into the Node worker, the worker hands the job
 * to a sidecar and passes its answer straight back.
 *
 * The protocol is one JSON job on stdin, one JSON result on stdout. No sockets,
 * no arguments carrying data, one process per job — so a workbook that takes the
 * sidecar down costs one job.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ArtifactRequest, ArtifactResponse } from "../engine.js";

function binaryName(): string {
  return process.platform === "win32" ? "umbratic-artifacts.exe" : "umbratic-artifacts";
}

/**
 * Where the sidecar lives, packaged first and then from the build tree.
 *
 * The debug path is last on purpose: a developer with both built should get the
 * release binary, which is the one a user would run.
 */
export function sidecarPath(): string | null {
  const filename = binaryName();
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "artifacts", filename));
  // Walking up to find the build tree rather than counting directories: this
  // file sits at a different depth in `src` than it does in `dist-electron`,
  // and a fixed count silently stops finding the binary the moment either
  // layout changes.
  let directory = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(path.join(directory, "target", "release", filename));
    candidates.push(path.join(directory, "target", "debug", filename));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export function sidecarAvailable(): boolean {
  return sidecarPath() !== null;
}

/** What a result may weigh. An outline of a large workbook is the big case. */
const maxResultBytes = 16 * 1024 * 1024;

export async function runXlsxJob(
  request: ArtifactRequest,
  timeoutMs: number,
): Promise<ArtifactResponse> {
  const binary = sidecarPath();
  if (!binary) {
    return {
      ok: false,
      kind: "runtime",
      errors: [
        {
          path: "",
          message: "the spreadsheet engine is not present in this build",
        },
      ],
    };
  }

  const job = {
    action: request.action,
    format: "xlsx",
    ...(request.path ? { path: request.path } : {}),
    ...(request.out ? { out: request.out } : {}),
    ...(request.absolutePath ? { absolutePath: request.absolutePath } : {}),
    ...(request.absoluteOut ? { absoluteOut: request.absoluteOut } : {}),
    ...(request.spec !== undefined ? { spec: request.spec } : {}),
    ...(request.ops ? { ops: request.ops } : {}),
  };

  return new Promise((resolve) => {
    const child = spawn(binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      // The sidecar resolves nothing relative to its own directory; the paths
      // it is given are already absolute and already confined.
      cwd: path.dirname(binary),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (response: ArtifactResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
            message: `the spreadsheet engine did not finish within ${Math.round(timeoutMs / 1000)} seconds; nothing was written`,
          },
        ],
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      // A runaway result is cut off here rather than growing until the process
      // runs out of memory.
      if (stdout.length > maxResultBytes) {
        finish({
          ok: false,
          kind: "runtime",
          errors: [{ path: "", message: "the spreadsheet engine returned more than the result limit" }],
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error: Error) =>
      finish({
        ok: false,
        kind: "runtime",
        errors: [{ path: "", message: `the spreadsheet engine could not start: ${error.message}` }],
      }),
    );
    child.once("close", () => {
      if (settled) return;
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish({
          ok: false,
          kind: "runtime",
          errors: [
            {
              path: "",
              message: `the spreadsheet engine returned nothing${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`,
            },
          ],
        });
        return;
      }
      try {
        finish(JSON.parse(trimmed) as ArtifactResponse);
      } catch {
        finish({
          ok: false,
          kind: "runtime",
          errors: [{ path: "", message: "the spreadsheet engine returned a result that could not be read" }],
        });
      }
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(job));
  });
}
