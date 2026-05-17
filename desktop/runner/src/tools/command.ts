import { spawn } from "node:child_process";
import { classifyCommandText, redactCommandText, redactText } from "../policy.js";
import { type ToolContext, type ToolResult } from "./common.js";

export async function commandTool(ctx: ToolContext, input: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("command requires command");
  const classification = classifyCommandText(command, ctx.cwd);
  if (classification.commandClass === "network" || classification.commandClass === "external-directory") {
    throw new Error(`Command blocked by policy: ${classification.reason ?? classification.commandClass}`);
  }
  if (classification.commandClass === "python-runtime" && classification.risky) {
    throw new Error("Bare python commands are blocked; use uv or a workspace virtual environment.");
  }
  const decision = await ctx.askPermission({
    permissionKind: "bash",
    summary: redactCommandText(command),
    autoAllow: ctx.permissionMode === "bypass" && !classification.risky,
  });
  if (decision !== "allow") throw new Error("Command denied.");
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
      resolve({
        title: redactCommandText(command),
        output: [`exitCode=${code ?? "unknown"}`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
        exitCode: code,
      });
    });
  });
}
