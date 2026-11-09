import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { isGeneratedRuntimePath } from "./policy";

export async function relevantReviewPaths(root: string, paths: string[]): Promise<string[]> {
  const userData = app.getPath("userData");
  const managedRoot = path.join(fs.existsSync(userData) ? fs.realpathSync(userData) : userData, "cloud");
  root = fs.realpathSync(root);
  const candidates = paths.filter(file => {
    const relative = path.relative(managedRoot, path.resolve(root, file));
    return !isGeneratedRuntimePath(file) && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
  });
  if (!candidates.length) return [];
  const ignored = await new Promise<Set<string>>((resolve, reject) => {
    const child = spawn("git", ["check-ignore", "--no-index", "-z", "--stdin"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Reading review ignore rules timed out.")); }, 15_000);
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-4096); });
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) { reject(new Error(error || "Cannot read repository ignore rules.")); return; }
      resolve(new Set(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean)));
    });
    child.stdin.end(candidates.join("\0") + "\0");
  });
  return candidates.filter(file => !ignored.has(file));
}
