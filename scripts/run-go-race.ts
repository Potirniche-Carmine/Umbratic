import path from "node:path";
import { spawnSync } from "node:child_process";

const project = process.argv[2];
if (!project) {
  console.error("Usage: node scripts/run-go-race.ts <project-directory>");
  process.exit(2);
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const projectDirectory = path.resolve(repositoryRoot, project);
const cgo = spawnSync("go", ["env", "CGO_ENABLED"], {
  cwd: projectDirectory,
  encoding: "utf8",
});

if (cgo.status !== 0) {
  process.stderr.write(cgo.stderr);
  process.exit(cgo.status ?? 1);
}

if (process.platform === "win32" && cgo.stdout.trim() !== "1") {
  console.log("Go race test skipped on Windows because CGO is disabled.");
  process.exit(0);
}

const test = spawnSync("go", ["test", "-race", "./..."], {
  cwd: projectDirectory,
  stdio: "inherit",
});
process.exit(test.status ?? 1);
