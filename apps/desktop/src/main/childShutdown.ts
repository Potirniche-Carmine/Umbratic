import { spawn, type ChildProcess } from "node:child_process";

/**
 * Deliberate shutdown of a supervised child process, shared by the llama-server
 * and local-Veil supervisors, runners, and SSH commands. Stopped children are
 * remembered so an exit handler can tell "we stopped it" apart from "it died".
 */

const stoppingChildren = new WeakSet<ChildProcess>();

export function stopRequested(child: ChildProcess): boolean {
  return stoppingChildren.has(child);
}

export function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null || stoppingChildren.has(child)) return;
  stoppingChildren.add(child);
  // `killed` only means a signal was sent, not that the process exited. A
  // stalled child must not hold a runner's workspace lease indefinitely.
  const forceStop = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 10_000);
  forceStop.unref();
  child.once("exit", () => clearTimeout(forceStop));
  // A plain kill on Windows leaves the child's own children behind; llama-server
  // holds the port until every one of them is gone.
  if (process.platform === "win32" && child.pid) {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.once("error", () => child.kill());
    terminator.unref();
    return;
  }
  child.kill();
}
