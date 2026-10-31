import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function goTestArguments(environment: { CGO_ENABLED: string; GOOS: string; GOARCH: string }): string[] {
  // Go supports the Windows race detector only on amd64 with CGO. Every
  // platform still runs the complete test suite; supported jobs retain -race.
  const windowsWithoutRace = environment.GOOS === "windows"
    && (environment.GOARCH !== "amd64" || environment.CGO_ENABLED !== "1");
  return ["test", ...(windowsWithoutRace ? [] : ["-race"]), "./..."];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = process.argv[2];
  if (!project) {
    console.error("Usage: node scripts/run-go-race.ts <project-directory>");
    process.exit(2);
  }
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const projectDirectory = path.resolve(repositoryRoot, project);
  const result = spawnSync("go", ["env", "-json", "CGO_ENABLED", "GOOS", "GOARCH"], {
    cwd: projectDirectory, encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const environment = JSON.parse(result.stdout);
  const args = goTestArguments(environment);
  if (!args.includes("-race")) {
    console.log(`Go race detection is unavailable on ${environment.GOOS}/${environment.GOARCH} with CGO=${environment.CGO_ENABLED}; running all Go tests without it.`);
  }
  const test = spawnSync("go", args, { cwd: projectDirectory, stdio: "inherit" });
  process.exit(test.status ?? 1);
}
