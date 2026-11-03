import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RpcMessage = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: { code?: number; message?: string } };
export class CloudRpc {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private child: ChildProcessWithoutNullStreams;
  private closed = false;
  onMessage: (message: RpcMessage) => void = () => undefined;
  onClose: (error: Error) => void = () => undefined;

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, { cwd, env, stdio: "pipe", windowsHide: true, shell: false });
    this.child.stderr.resume(); // Runtime stderr can contain local paths or auth diagnostics; do not persist it.
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("Protocol message too large");
        const message: RpcMessage = JSON.parse(line);
        if (typeof message.id === "number" && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message || "The runtime rejected the request."));
          else pending.resolve(message.result);
        } else this.onMessage(message);
      } catch { this.fail(new Error("The runtime returned an invalid protocol message.")); }
    });
    this.child.on("error", () => this.fail(new Error("Could not start Codex. Install the official CLI or choose its executable in Settings.")));
    this.child.on("exit", () => this.fail(new Error("The Codex runtime stopped. Reconnect and try again.")));
    this.child.stdin.on("error", () => this.fail(new Error("The runtime connection closed.")));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.kill();
    this.onClose(error);
  }
  send(message: RpcMessage): void {
    if (this.closed) throw new Error("The runtime connection is closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("The runtime connection is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The runtime timed out during ${method}.`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  close(): void { this.fail(new Error("The runtime connection was closed.")); }
}
