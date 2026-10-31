import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const [version, ...extra] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || extra.length) throw new Error("Usage: npm run release:version -- MAJOR.MINOR.PATCH");
if (!process.env.npm_execpath) throw new Error("Run through npm run release:version.");
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"], { cwd: root, encoding: "utf8" }));
execFileSync(process.execPath, [process.env.npm_execpath, "version", version!, "--workspaces", "--include-workspace-root", "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"], { cwd: root, stdio: "inherit" });
for (const entry of metadata.packages.filter((entry) => metadata.workspace_members.includes(entry.id))) {
  const file = entry.manifest_path;
  const source = fs.readFileSync(file, "utf8");
  if (!/^version = "[^"]+"$/m.test(source)) throw new Error(`Expected a package version in ${file}.`);
  fs.writeFileSync(file, source.replace(/^version = "[^"]+"$/m, `version = "${version}"`));
}
// Re-resolve only local workspace versions using the already locked registry
// graph. Offline mode prevents fetching dependencies during a version bump.
execFileSync("cargo", ["metadata", "--offline", "--no-deps", "--format-version", "1"], { cwd: root, stdio: "ignore" });
execFileSync(process.execPath, [path.join(root, "scripts/check-release-version.ts")], { cwd: root, stdio: "inherit" });
