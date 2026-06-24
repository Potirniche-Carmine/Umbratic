import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(desktopRoot, "../..");
const runnerRoot = path.join(monorepoRoot, "packages/runner");
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
    "  npm run desktop:dev -- --server https://veil.example --software vllm",
    "",
    "Options:",
    "  --server <url>       Run dev against a managed server endpoint for this process.",
    "  --software <name>    ollama or vllm. Defaults to vllm with --server.",
    "  --api-key <secret>   API key for the endpoint.",
    "  --composer-test      Open the seeded composer UI test fixture in Electron.",
    "  --help              Show this message.",
  ].join("\n");
}

function devEndpointEnv(args) {
  if (hasFlag(args, "--help")) {
    console.log(usage());
    process.exit(0);
  }

  const server = readFlag(args, "--server");
  const software = readFlag(args, "--software");
  const apiKey = readFlag(args, "--api-key");
  const env = {
    UMBRATIC_ALLOW_ENDPOINT_EDIT: process.env.UMBRATIC_ALLOW_ENDPOINT_EDIT || "1",
  };

  if (hasFlag(args, "--composer-test")) {
    env.UMBRATIC_RENDERER_QUERY = "composerTest=1";
  }

  if (server !== undefined) {
    if (!server) {
      throw new Error("--server requires a URL.");
    }
    env.UMBRATIC_MANAGED_ENDPOINT_MODE = "server";
    env.UMBRATIC_MANAGED_MODEL_BASE_URL = server;
    env.UMBRATIC_MANAGED_MODEL_SOFTWARE = software || "vllm";
  } else if (software) {
    env.UMBRATIC_MODEL_SOFTWARE = software;
  }

  if (software && !["ollama", "vllm"].includes(software)) {
    throw new Error("--software must be one of: ollama, vllm.");
  }
  if (apiKey && server !== undefined) {
    env.UMBRATIC_MANAGED_MODEL_API_KEY = apiKey;
  } else if (apiKey) {
    env.UMBRATIC_MODEL_API_KEY = apiKey;
  }
  return env;
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: desktopRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(scriptPath)} exited with code ${code ?? "unknown"}`));
    });
  });
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
  await runNodeScript(tsc, ["-p", path.join(runnerRoot, "tsconfig.json")]);
  await runNodeScript(tsc, ["-p", "tsconfig.main.json"]);
}

async function main() {
  const cliEnv = devEndpointEnv(process.argv.slice(2));
  await buildDesktopProcessFiles();

  const viteServer = await createServer({
    configFile: path.join(desktopRoot, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: Number.isFinite(requestedPort) ? requestedPort : 5173,
    },
  });
  await viteServer.listen();
  viteServer.printUrls();

  const devServerUrl = localServerUrl(viteServer);
  const electron = spawn(require("electron"), ["."], {
    cwd: desktopRoot,
    stdio: "inherit",
    // On Windows, hiding the spawned process can also hide Electron's app window.
    windowsHide: false,
    env: {
      ...process.env,
      ...cliEnv,
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
