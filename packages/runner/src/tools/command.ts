import { spawn } from "node:child_process";
import { classifyCommandText, redactCommandText, redactStreamText } from "../policy.js";
import { toolError, type ToolContext, type ToolResult } from "./common.js";

const defaultCommandTimeoutMs = 10 * 60 * 1000;
const maxCommandTimeoutMs = 30 * 60 * 1000;

function commandTimeoutMs(input: Record<string, unknown>): number {
  const requested = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? Math.floor(input.timeoutMs)
    : defaultCommandTimeoutMs;
  return Math.min(maxCommandTimeoutMs, Math.max(100, requested));
}

export async function commandTool(ctx: ToolContext, input: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw toolError("validation_error", "invalid_arguments", "command requires command");
  const classification = classifyCommandText(command, ctx.cwd);
  if (classification.commandClass === "network" || classification.commandClass === "external-directory") {
    throw toolError("policy_blocked", "policy_blocked", `Command blocked by policy: ${classification.reason ?? classification.commandClass}`);
  }
  const decision = await ctx.askPermission({
    permissionKind: "bash",
    summary: redactCommandText(command),
    autoAllow: ctx.permissionMode === "bypass" && !classification.risky,
  });
  if (decision !== "allow") throw toolError("permission_denied", "permission_denied", "Command denied.");
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  return await new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(shell, args, { cwd: ctx.cwd, detached: useProcessGroup, windowsHide: true });
    const timeoutMs = commandTimeoutMs(input);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall back to killing the shell when the process group no longer exists.
        }
      }
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = redactStreamText(chunk.toString("utf8"));
      stdout += text;
      ctx.emitToolOutput(toolCallId, "stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = redactStreamText(chunk.toString("utf8"));
      stderr += text;
      ctx.emitToolOutput(toolCallId, "stderr", text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        title: redactCommandText(command),
        output: [`exitCode=unknown`, stdout.trim(), stderr.trim(), error.message].filter(Boolean).join("\n"),
        status: "runtime_error",
        errorCode: "process_error",
        errorMessage: error.message,
        exitCode: null,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? null;
      resolve({
        title: redactCommandText(command),
        output: [`exitCode=${exitCode ?? "unknown"}`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
        status: timedOut ? "timeout" : exitCode === 0 ? "success" : "runtime_error",
        errorCode: timedOut ? "process_timeout" : exitCode === 0 ? undefined : "command_exit_nonzero",
        errorMessage: timedOut
          ? `Command timed out after ${timeoutMs} ms.`
          : exitCode === 0 ? undefined : `Command exited with code ${exitCode ?? "unknown"}.`,
        exitCode,
      });
    });
  });
}
