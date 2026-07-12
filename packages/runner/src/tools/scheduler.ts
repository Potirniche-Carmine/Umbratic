import { toolError } from "./common.js";
import type { ToolPlan } from "./plan.js";
import type { ToolCall, ToolExecutionMode, ToolExecutionResult, ToolRuntimeContext } from "./types.js";
import type { UmbraticRunnerEvent } from "../events.js";

type Waiter = { mode: ToolExecutionMode; resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void };

class ReadWriteGate {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];

  acquire(mode: ToolExecutionMode, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(toolError("aborted", "aborted", "Tool call was aborted while queued."));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        mode, resolve, reject, signal,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(toolError("aborted", "aborted", "Tool call was aborted while queued."));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  private grant(waiter: Waiter) {
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.mode === "exclusive") this.writer = true;
    else this.readers += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      if (waiter.mode === "exclusive") this.writer = false;
      else this.readers = Math.max(0, this.readers - 1);
      this.drain();
    });
  }

  private drain() {
    if (this.writer || !this.queue.length) return;
    const first = this.queue[0];
    if (first.mode === "exclusive") {
      if (this.readers > 0) return;
      this.queue.shift();
      this.grant(first);
      return;
    }
    while (this.queue[0]?.mode === "parallel" && !this.writer) this.grant(this.queue.shift()!);
  }
}

export class ToolScheduler {
  private readonly gate = new ReadWriteGate();

  async execute(plan: ToolPlan, context: ToolRuntimeContext, emit: (event: UmbraticRunnerEvent) => void, calls: readonly ToolCall[]): Promise<ToolExecutionResult[]> {
    return Promise.all(calls.map(async (call) => {
      const queuedAt = Date.now();
      const mode = plan.registry.get(call.name.namespace ? `${call.name.namespace}__${call.name.name}` : call.name.name)?.executionMode ?? "exclusive";
      let release: (() => void) | undefined;
      try {
        release = await this.gate.acquire(mode, context.signal);
        return await plan.registry.dispatch(context, emit, call, { queueWaitMs: Math.max(0, Date.now() - queuedAt), planFingerprint: plan.fingerprint });
      } finally {
        release?.();
      }
    }));
  }
}
