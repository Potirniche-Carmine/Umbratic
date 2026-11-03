import type { CloudApproval, CloudConnection, CloudSettings, CloudWorkspace } from "../shared/cloud";
export type ApprovalAnswer = { allow: boolean; answers?: Record<string, string> };
export type CloudRuntimeSink = {
  session(id: string, account: string): void;
  text(id: string, text: string, append: boolean): void;
  activity(text: string): void;
  compact(): void;
  usage(contextWindow?: number, inputTokens?: number): void;
  approval(request: Omit<CloudApproval, "id">): Promise<ApprovalAnswer>;
};
export type CloudRun = { done: Promise<void>; stop(): Promise<void> };
export type CloudRuntime = {
  inspect(settings: CloudSettings, cwd: string): Promise<CloudConnection>;
  signIn(settings: CloudSettings, cwd: string): Promise<{ message: string }>;
  run(settings: CloudSettings, workspace: CloudWorkspace, prompt: string, sink: CloudRuntimeSink): CloudRun;
};
