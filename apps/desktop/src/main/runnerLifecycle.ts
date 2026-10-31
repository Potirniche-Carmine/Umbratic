import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stopChild } from "./childShutdown";
import type { RunnerProcess } from "./types";

export const activeRunnerProcesses = new Map<string, RunnerProcess>();

type RunnerStartup = { ok: true } | { ok: false; output: string; portInUse: boolean };

/** Both local and SSH runners announce the same listener and take one config line. */
export function awaitRunnerListener(
  child: ChildProcess,
  expectedUrl: string,
  config: Record<string, unknown>,
  timeoutMs: number,
): Promise<RunnerStartup> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const maxOutput = 16 * 1024;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onError = () => finish(false);
    const onExit = () => finish(false);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdin?.off("error", onError);
      resolve(ok ? { ok: true } : {
        ok: false,
        output,
        portInUse: /address (already )?in use|cannot listen to port|remote port forwarding failed|bind: /i.test(output),
      });
    };
    const readStream = () => {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      return (chunk: Buffer) => {
        const text = decoder.write(chunk);
        output = (output + text).slice(-maxOutput);
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line === `umbratic runner listening on ${expectedUrl}`) {
            finish(true);
            return;
          }
          newline = pending.indexOf("\n");
        }
        pending = pending.slice(-maxOutput);
      };
    };
    const onStdout = readStream();
    const onStderr = readStream();
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin?.once("error", onError);
    // Attach every listener before writing: an early exit can break stdin.
    // Keep stdin open; EOF is the runner's parent-disconnected signal.
    try {
      child.stdin?.write(`${JSON.stringify(config)}\n`);
    } catch {
      finish(false);
    }
  });
}

export function stopRunnerProcess(run: RunnerProcess) {
  if (run.providerSessionRefresh) {
    clearInterval(run.providerSessionRefresh);
    run.providerSessionRefresh = undefined;
  }
  run.abortController.abort();
  // Closing stdin is the shutdown signal the runner listens for, and for a
  // remote run it is the only one that reaches it: killing the local ssh
  // process ends the channel, but nothing on the remote host would otherwise
  // tell the runner that the desktop is gone.
  if (!run.child.stdin?.destroyed) run.child.stdin?.end();
  stopChild(run.child);
}
