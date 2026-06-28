import { spawn } from "node:child_process";
import { classifyCommandText, redactCommandText, redactText } from "../policy.js";
import { toolError, type ToolContext, type ToolResult } from "./common.js";

export async function commandTool(ctx: ToolContext, input: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw toolError("validation_error", "invalid_arguments", "command requires command");
  const classification = classifyCommandText(command, ctx.cwd);
  if (classification.commandClass === "network" || classification.commandClass === "external-directory") {
    throw toolError("policy_blocked", "policy_blocked", `Command blocked by policy: ${classification.reason ?? classification.commandClass}`);
  }
  if (classification.commandClass === "python-runtime" && classification.risky) {
    throw toolError("policy_blocked", "policy_blocked", "Bare python commands are blocked; use uv or a workspace virtual environment.");
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
    const child = spawn(shell, args, { cwd: ctx.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = redactText(chunk.toString("utf8"));
      stdout += text;
      ctx.emitToolOutput(toolCallId, "stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = redactText(chunk.toString("utf8"));
      stderr += text;
      ctx.emitToolOutput(toolCallId, "stderr", text);
    });
    child.on("close", (code) => {
      const exitCode = code ?? null;
      resolve({
        title: redactCommandText(command),
        output: [`exitCode=${exitCode ?? "unknown"}`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
        status: exitCode === 0 ? "success" : "runtime_error",
        errorCode: exitCode === 0 ? undefined : "command_exit_nonzero",
        errorMessage: exitCode === 0 ? undefined : `Command exited with code ${exitCode ?? "unknown"}.`,
        exitCode,
      });
    });
  });
}
