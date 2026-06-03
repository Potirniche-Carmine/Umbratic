import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const requestedPort = Number(process.env.UMBRATIC_DEV_PORT || "5173");

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
  await runNodeScript(tsc, ["-p", "runner/tsconfig.json"]);
  await runNodeScript(tsc, ["-p", "tsconfig.main.json"]);
}

async function main() {
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
    windowsHide: true,
    env: {
      ...process.env,
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
