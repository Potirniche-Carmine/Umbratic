import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, createServer } from "vite";

import { prepareRendererDevelopmentEnvironment } from "./devEnvironment.ts";
import { resolveInstalledElectron } from "./electron-runtime.ts";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(desktopRoot, "../..");
const copySystemSkillsScript = path.join(desktopRoot, "scripts/copy-system-skills.ts");
const requestedPort = Number(process.env.UMBRATIC_DEV_PORT || "5173");

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

function hasFlag(args, name) {
  return args.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  npm run desktop:dev",
    "",
    "Options:",
    "  --server <url>       Run dev against a managed server endpoint for this process.",
    "  --api-key <secret>   API key for the endpoint.",
    "  --help              Show this message.",
    "",
    "Builds and uses a local Veil binary so local mode works without a compile on",
    "the first message. Set UMBRATIC_VEIL_BINARY to point at your own build instead.",
  ].join("\n");
}

function devEndpointEnv(args) {
  if (hasFlag(args, "--help")) {
    console.log(usage());
    process.exit(0);
  }

  const server = readFlag(args, "--server");
  const apiKey = readFlag(args, "--api-key");
  const env = {
    UMBRATIC_ALLOW_ENDPOINT_EDIT: process.env.UMBRATIC_ALLOW_ENDPOINT_EDIT || "1",
  };

  if (server !== undefined) {
    if (!server) {
      throw new Error("--server requires a URL.");
    }
    env.UMBRATIC_MANAGED_ENDPOINT_MODE = "server";
    env.UMBRATIC_VEIL_BASE_URL = server;
  }

  if (apiKey && server !== undefined) {
    env.UMBRATIC_MANAGED_MODEL_API_KEY = apiKey;
  } else if (apiKey) {
    env.UMBRATIC_VEIL_TOKEN = apiKey;
  }
  return env;
}

function runNodeScript(scriptPath, args) {
  return runCommand(process.execPath, [scriptPath, ...args], desktopRoot, path.basename(scriptPath));
}

function runCommand(command, args, cwd, label = command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}

// Veil runs from source in development, where the app starts it with
// `go run ./cmd/veil`. That compiles the whole Go tree on the first request —
// inside the app, while the reader waits on their first message — and a Go
// compile error surfaces there rather than here. Building the binary up front
// costs a second at startup, makes the first message as fast as the rest, and
// turns a broken Go tree into a failure to start. The output goes where
// `desktop:release` puts it, so the two share one artifact.
async function buildLocalVeil() {
  if (process.env.UMBRATIC_VEIL_BINARY?.trim()) return process.env.UMBRATIC_VEIL_BINARY.trim();
  const binary = path.join(monorepoRoot, "target", "go", process.platform === "win32" ? "veil.exe" : "veil");
  const source = path.join(monorepoRoot, "infrastructure", "veil");
  await fs.mkdir(path.dirname(binary), { recursive: true });
  try {
    await runCommand("go", ["build", "-o", binary, "./cmd/veil"], source, "go build ./cmd/veil");
  } catch (error) {
    // Without Go the app can still run against a server endpoint, and local
    // mode will report the missing runtime itself. Refusing to start the whole
    // dev loop over it would be worse than saying so.
    console.warn(`Local Veil was not built: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("Install Go to use local mode, or run against a server with --server <url>.");
    return undefined;
  }
  return binary;
}

function localServerUrl(server) {
  const address = server.httpServer?.address();
  if (address && typeof address !== "string") {
    return `http://127.0.0.1:${address.port}/`;
  }
  return server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${requestedPort}/`;
}

async function buildDesktopProcessFiles() {
  const tsc = require.resolve("typescript/bin/tsc");
  await new Promise((resolve, reject) => {
    const child = spawn("cargo", ["build", "--locked", "--release", "--workspace"], {
      cwd: monorepoRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`cargo build exited with code ${code ?? "unknown"}`)));
  });
  await runNodeScript(tsc, ["-p", "tsconfig.main.json"]);
  await build({
    configFile: path.join(desktopRoot, "vite.preload.config.mts"),
  });
  await runNodeScript(copySystemSkillsScript, []);
}

async function main() {
  const cliEnv = devEndpointEnv(process.argv.slice(2));
  const veilBinary = await buildLocalVeil();
  await buildDesktopProcessFiles();
  prepareRendererDevelopmentEnvironment(process.env);

  const viteServer = await createServer({
    configFile: path.join(desktopRoot, "vite.config.mts"),
    server: {
      host: "127.0.0.1",
      port: Number.isFinite(requestedPort) ? requestedPort : 5173,
    },
  });
  await viteServer.listen();
  viteServer.printUrls();

  const devServerUrl = localServerUrl(viteServer);
  const electron = spawn(resolveInstalledElectron(), ["."], {
    cwd: desktopRoot,
    stdio: "inherit",
    // On Windows, hiding the spawned process can also hide Electron's app window.
    windowsHide: false,
    env: {
      ...process.env,
      ...cliEnv,
      ...(veilBinary ? { UMBRATIC_VEIL_BINARY: veilBinary } : {}),
      UMBRATIC_DEV_SERVER_URL: devServerUrl,
    },
  });

  const shutdown = async (code = 0) => {
    electron.kill();
    await viteServer.close();
    process.exit(code);
  };

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  electron.once("exit", (code) => void shutdown(code ?? 0));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});


