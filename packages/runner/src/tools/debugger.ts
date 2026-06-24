import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { redactCommandText, redactText } from "../policy.js";
import { resolveWorkspacePath, type ToolContext, type ToolResult } from "./common.js";

type DebuggerId = "auto" | "gdb" | "lldb" | "cdb";

const supportedDebuggers: DebuggerId[] = ["auto", "gdb", "lldb", "cdb"];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 15000;
  return Math.max(1000, Math.min(45000, Math.trunc(value)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandAvailable(command: string): boolean {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true, timeout: 5000 })
      : spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { encoding: "utf8", timeout: 5000 });
  return lookup.status === 0;
}

function debuggerCandidates(preferred: DebuggerId): Exclude<DebuggerId, "auto">[] {
  if (preferred !== "auto") return [preferred];
  if (process.platform === "win32") return ["cdb", "lldb", "gdb"];
  if (process.platform === "darwin") return ["lldb", "gdb"];
  return ["gdb", "lldb"];
}

function installGuide(): string {
  if (process.platform === "win32") {
    return [
      "Install a debugger on Windows:",
      "- `winget install LLVM.LLVM` for lldb",
      "- `winget install Microsoft.WindowsSDK` for cdb / Debugging Tools for Windows",
      "- `winget install Microsoft.VisualStudio.2022.BuildTools --override \"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive\"` for MSVC symbols/toolchain",
    ].join("\n");
  }
  if (process.platform === "darwin") {
    return [
      "Install a debugger on macOS:",
      "- `xcode-select --install` for lldb and clang",
      "- `brew install llvm` if you need a newer lldb",
    ].join("\n");
  }
  return [
    "Install a debugger on Linux:",
    "- Ubuntu/Debian: `sudo apt-get install -y gdb lldb`",
    "- Fedora: `sudo dnf install gdb lldb`",
    "- Arch: `sudo pacman -S gdb lldb`",
  ].join("\n");
}

function pickDebugger(preferred: DebuggerId): Exclude<DebuggerId, "auto"> {
  for (const candidate of debuggerCandidates(preferred)) {
    if (commandAvailable(candidate)) return candidate;
  }
  throw new Error(`No supported debugger found. ${installGuide()}`);
}

function lldbEscape(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function invocation(debuggerId: Exclude<DebuggerId, "auto">, executablePath: string, programArgs: string[]) {
  if (debuggerId === "gdb") {
    return {
      command: "gdb",
      args: [
        "--quiet",
        "--batch",
        "-ex",
        "set pagination off",
        "-ex",
        "set print pretty on",
        "-ex",
        "set confirm off",
        "-ex",
        "run",
        "-ex",
        "bt full",
        "-ex",
        "info registers",
        "-ex",
        "info locals",
        "-ex",
        "x/32gx $sp",
        "--args",
        executablePath,
        ...programArgs,
      ],
    };
  }
  if (debuggerId === "lldb") {
    const launch = programArgs.length ? `process launch -- ${programArgs.map(lldbEscape).join(" ")}` : "run";
    return {
      command: "lldb",
      args: [
        "--batch",
        "--no-lldbinit",
        "--file",
        executablePath,
        "-o",
        "settings set stop-disassembly-display never",
        "-o",
        launch,
        "-o",
        "thread backtrace all",
        "-o",
        "frame variable --show-types",
        "-o",
        "register read",
        "-o",
        "memory read --format x --size 8 --count 32 $sp",
      ],
    };
  }
  return {
    command: "cdb",
    args: ["-lines", "-G", "-c", "g; kb; dv; r; dq @rsp L20; q", executablePath, ...programArgs],
  };
}

export async function debuggerTool(ctx: ToolContext, input: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
  const executableInput =
    typeof input.executablePath === "string"
      ? input.executablePath.trim()
      : typeof input.binaryPath === "string"
        ? input.binaryPath.trim()
        : "";
  if (!executableInput) throw new Error("debugger requires executablePath");

  const preferred = typeof input.debugger === "string" && supportedDebuggers.includes(input.debugger as DebuggerId)
    ? input.debugger as DebuggerId
    : "auto";
  const programArgs = asStringArray(input.args);
  const timeoutMs = clampTimeout(input.timeoutMs);
  const executable = resolveWorkspacePath(ctx.cwd, executableInput);
  if (!fs.existsSync(executable.absolute) || !fs.statSync(executable.absolute).isFile()) {
    throw new Error(`debugger executable was not found: ${executable.relative}`);
  }

  const debuggerId = pickDebugger(preferred);
  const run = invocation(debuggerId, executable.absolute, programArgs);
  const summary = redactCommandText(`debugger ${debuggerId} ${executable.relative}${programArgs.length ? ` ${programArgs.join(" ")}` : ""}`);
  const decision = await ctx.askPermission({
    permissionKind: "bash",
    summary,
    autoAllow: ctx.permissionMode === "bypass",
  });
  if (decision !== "allow") throw new Error("Debugger denied.");

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(run.command, run.args, { cwd: ctx.cwd, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = redactText(chunk.toString("utf8"), 4000);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      ctx.emitToolOutput(toolCallId, stream, text);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      const text = redactText(error.message);
      stderr += text;
      ctx.emitToolOutput(toolCallId, "stderr", text);
      resolve({ title: summary, output: [`debugger=${debuggerId}`, "exitCode=1", stderr.trim()].filter(Boolean).join("\n") });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        title: summary,
        output: [
          `debugger=${debuggerId}`,
          `exitCode=${timedOut ? "timeout" : code ?? "unknown"}`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join("\n"),
      });
    });
  });
}
