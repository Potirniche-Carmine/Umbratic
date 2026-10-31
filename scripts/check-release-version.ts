import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Desktop releases require a stable semantic version.");
const npmManifests = ["apps/desktop/package.json", ...fs.readdirSync(path.join(root, "packages"))
  .map((name) => `packages/${name}/package.json`).filter((file) => fs.existsSync(path.join(root, file)))];
for (const file of npmManifests) {
  if (JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).version !== version) throw new Error(`${file} does not match release ${version}. Run npm run release:version -- ${version}.`);
}
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (lock.version !== version || lock.packages[""].version !== version) throw new Error("Root npm lockfile version is out of sync.");
for (const file of npmManifests) {
  if (lock.packages[path.posix.dirname(file)]?.version !== version) throw new Error(`Lockfile version for ${file} is out of sync.`);
}
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"], { cwd: root, encoding: "utf8" }));
const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8").split("\n[[package]]\n");
for (const entry of metadata.packages.filter((entry) => metadata.workspace_members.includes(entry.id))) {
  if (entry.version !== version) throw new Error(`${entry.name} does not match release ${version}. Run npm run release:version -- ${version}.`);
  const locked = cargoLock.find((block) => block.match(/^name = "([^"]+)"$/m)?.[1] === entry.name && !/^source =/m.test(block));
  if (locked?.match(/^version = "([^"]+)"$/m)?.[1] !== version) throw new Error(`Cargo.lock version for ${entry.name} is out of sync.`);
}
console.log(`Release versions match ${version} across npm, Cargo and locked workspaces.`);
