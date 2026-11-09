import { execFileOutput } from "./processCommands";
import { cloudEnvironment } from "./cloudPolicy";
import * as path from "node:path";
import type { CloudSettings, CloudWorkspace } from "../shared/cloud";

export const playwrightMcpVersion = "0.0.84";
export function cloudBrowserServer(settings: CloudSettings, workspace: CloudWorkspace) {
  if (!settings.browserVerification) return undefined;
  if (!workspace.scratchPath) throw new Error("Reopen this chat to prepare its browser workspace.");
  return { command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", `@playwright/mcp@${playwrightMcpVersion}`, "--isolated", "--headless", "--browser", "chromium", "--output-dir", path.join(workspace.scratchPath, "browser")],
    cwd: workspace.scratchPath };
}
export function codexBrowserConfig(settings: CloudSettings, workspace: CloudWorkspace): Record<string, unknown> {
  const server = cloudBrowserServer(settings, workspace);
  return server ? { "mcp_servers.umbratic_browser": { ...server, startup_timeout_sec: 120, tool_timeout_sec: 120 } }
    : { "mcp_servers.umbratic_browser": { command: process.platform === "win32" ? "npx.cmd" : "npx", args: [], enabled: false } };
}

let installing: Promise<void> | undefined;
export function installCloudBrowser(): Promise<void> {
  if (installing) return installing;
  const args = ["--yes", `--package=@playwright/mcp@${playwrightMcpVersion}`, "playwright", "install", "chromium"];
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  installing = execFileOutput(command, process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args,
    { env: cloudEnvironment(), timeout: 300_000 }).then(() => undefined).catch(() => { throw new Error("Browser installation failed. Check that Node.js/npm is installed and the Playwright download servers are reachable."); }).finally(() => { installing = undefined; });
  return installing;
}
