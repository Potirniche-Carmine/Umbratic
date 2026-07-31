import { execFile } from "node:child_process";

import type { CommandResult } from "./types";

export function execFileOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeout ?? 180000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function execFileResult(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeout ?? 180000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error ? 1 : 0;
      resolve({
        stdout: String(stdout),
        stderr: String(stderr) || (error ? String(error.message) : ""),
        exitCode,
        success: !error,
      });
    });
  });
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileOutput("git", args, { cwd })).stdout.trim();
}

export function gitResult(cwd: string, args: string[]): Promise<CommandResult> {
  return execFileResult("git", args, { cwd });
}

export async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileOutput(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
