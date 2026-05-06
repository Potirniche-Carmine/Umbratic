import { nowIso, type AegisRunnerEvent } from "./events.js";

export type PermissionDecision = "allow" | "deny";

type PendingPermission = {
  id: string;
  taskId: string;
  resolve: (decision: PermissionDecision) => void;
};

export class PermissionBroker {
  private pending = new Map<string, PendingPermission>();

  constructor(private readonly emit: (event: AegisRunnerEvent) => void) {}

  request(input: {
    taskId: string;
    permissionKind: string;
    summary: string;
    autoAllow: boolean;
  }): Promise<PermissionDecision> {
    const id = `perm-${crypto.randomUUID()}`;
    this.emit({
      type: "permission.requested",
      taskId: input.taskId,
      permissionId: id,
      permissionKind: input.permissionKind,
      summary: input.summary,
      at: nowIso(),
    });
    if (input.autoAllow) {
      this.emit({ type: "permission.resolved", taskId: input.taskId, permissionId: id, decision: "allow", at: nowIso() });
      return Promise.resolve("allow");
    }
    return new Promise((resolve) => {
      this.pending.set(id, { id, taskId: input.taskId, resolve });
    });
  }

  reply(permissionId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    this.pending.delete(permissionId);
    pending.resolve(decision);
    this.emit({ type: "permission.resolved", taskId: pending.taskId, permissionId, decision, at: nowIso() });
    return true;
  }

  denyAll(taskId: string) {
    for (const pending of this.pending.values()) {
      if (pending.taskId === taskId) this.reply(pending.id, "deny");
    }
  }
}
