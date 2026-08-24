import { spawn, type ChildProcess } from "node:child_process";

/**
 * Deliberate shutdown of a supervised child process, shared by the llama-server
 * and local-Veil supervisors. Children stopped through here are remembered, so
 * an exit handler can tell "we stopped it" apart from "it died".
 */

const stoppingChildren = new WeakSet<ChildProcess>();

export function stopRequested(child: ChildProcess): boolean {
  return stoppingChildren.has(child);
}

export function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.killed) return;
  stoppingChildren.add(child);
  // A plain kill on Windows leaves the child's own children behind; llama-server
  // holds the port until every one of them is gone.
  if (process.platform === "win32" && child.pid) {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.unref();
    return;
  }
  child.kill();
}
