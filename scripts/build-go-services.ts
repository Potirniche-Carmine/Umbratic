// Builds the two Go services into target/go so `npm run build` covers every
// language in the repository.
//
// The desktop runs Veil with `go run ./cmd/veil` from source in development, so
// nothing in the normal loop ever compiled the Go tree. A Go compile error could
// therefore survive `npm run build` and only surface when the app tried to start
// Veil. These binaries exist to make that failure a build failure; the packaged
// path still builds its own copies through scripts/run-veil-console.ts.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(repositoryRoot, "target", "go");

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal ? `${command} stopped with ${signal}` : `${command} exited with code ${code ?? 1}`));
    });
  });
}

const services = [
  { module: "veil", command: "./cmd/veil", binary: "veil" },
  { module: "veil-console", command: "./cmd/veil-console", binary: "veil-console" },
] as const;

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  for (const service of services) {
    const output = path.join(outputDirectory, executableName(service.binary));
    console.log(`Building ${service.binary}`);
    await run(
      "go",
      ["build", "-trimpath", "-o", output, service.command],
      path.join(repositoryRoot, "infrastructure", service.module),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
