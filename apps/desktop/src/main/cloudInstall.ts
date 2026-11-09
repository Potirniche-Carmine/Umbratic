import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { isCloudProvider, type CloudProvider } from "../shared/cloud";
import { cloudEnvironment } from "./cloudPolicy";

export class CloudRuntimeMissing extends Error {}

// These are the vendors' documented native installers, run unchanged, without
// sudo or command interpolation. Installer URLs cannot come from the renderer.
export function cloudInstallPlan(provider: CloudProvider, platform = process.platform) {
  if (!isCloudProvider(provider)) throw new Error("Choose Codex or Claude Code.");
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("Installation is not supported on this platform.");
  const windows = platform === "win32";
  return {
    url: provider === "codex" ? `https://chatgpt.com/codex/install.${windows ? "ps1" : "sh"}` : `https://claude.ai/install.${windows ? "ps1" : "sh"}`,
    extension: windows ? "ps1" : "sh",
    executable: windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : provider === "codex" ? "/bin/sh" : "/bin/bash",
    args: windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] : [],
  };
}

export async function downloadCloudInstaller(url: string, signal: AbortSignal): Promise<string> {
  const allowed = ["codex", "claude"].flatMap(provider => ["darwin", "win32"].map(platform => cloudInstallPlan(provider as CloudProvider, platform as NodeJS.Platform).url));
  if (!allowed.includes(url)) throw new Error("Unsupported installer address.");
  let response = await fetch(url, { signal, redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const extension = url.endsWith(".ps1") ? "ps1" : "sh";
    const target = url.startsWith("https://chatgpt.com/") ? `https://releases.openai.com/codex/install.${extension}` : `https://downloads.claude.ai/claude-code-releases/bootstrap.${extension}`;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || new URL(location, url).href !== target) throw new Error("The provider returned an unexpected installer address.");
    response = await fetch(target, { signal, redirect: "error" });
  }
  if (!response.ok || !response.body) throw new Error(`Could not download the installer (${response.status}). Try again.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("The installer download was unexpectedly large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const script = Buffer.concat(chunks).toString("utf8");
  if (!script.trim() || /^\s*<!?(?:doctype|html)/i.test(script)) throw new Error("The provider did not return an installer. Try again.");
  return script;
}

let installation: AbortController | undefined;
export function cloudInstallInProgress(): boolean { return !!installation; }
export function stopCloudInstall(): void { installation?.abort(); }

export async function installOfficialCloudRuntime(provider: CloudProvider): Promise<void> {
  if (installation) throw new Error("An installation is already running.");
  const plan = cloudInstallPlan(provider);
  const controller = new AbortController(); installation = controller;
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  let directory: string | undefined;
  try {
    const script = await downloadCloudInstaller(plan.url, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbratic-provider-install-"));
    const file = path.join(directory, `install.${plan.extension}`);
    await fs.writeFile(file, script, { mode: 0o600 });
    const env = cloudEnvironment();
    // Inherited installer overrides must not change the official source or target.
    for (const key of Object.keys(env)) if (/^(CODEX_INSTALL|CODEX_RELEASE|CODEX_UPDATE|CLAUDE_INSTALL|BASH_ENV$|ENV$)/i.test(key)) delete env[key];
    env.CODEX_NON_INTERACTIVE = "1";
    await new Promise<void>((resolve, reject) => {
      controller.signal.throwIfAborted();
      const child = spawn(plan.executable, [...plan.args, file], { cwd: directory, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      const abort = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const kill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
          kill.on("error", () => child.kill());
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      child.once("error", error => { controller.signal.removeEventListener("abort", abort); reject(error); });
      child.once("close", code => {
        controller.signal.removeEventListener("abort", abort);
        if (controller.signal.aborted) reject(new Error("Installation was interrupted. You can try again."));
        else if (code === 0) resolve();
        else reject(new Error(`Installation did not finish. ${output.replace(/\u001b\[[0-9;]*m/g, "").trim().slice(-1500)}`));
      });
    });
  } finally {
    clearTimeout(timeout); installation = undefined;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
