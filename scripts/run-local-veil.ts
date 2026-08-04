import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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
    "  npm run local",
    "  npm run local -- --model llama3.1",
    "  npm run local -- --base-url http://127.0.0.1:11434 --model llama3.1",
    "",
    "Options:",
    "  --base-url <url>     Local Ollama URL. Overrides UMBRATIC_LOCAL_RUNTIME_BASE_URL.",
    "  --model <name>       Runtime model name. Overrides UMBRATIC_LOCAL_MODEL_ID.",
    "  --help              Show this message.",
    "",
    "Starts with Local as the first-run default. Local mode always uses Ollama through Veil.",
    "You can switch between Local and Server in Settings.",
  ].join("\n");
}

function envWithOverrides(args, baseEnv) {
  const env = { ...baseEnv };
  const overrides = {
    UMBRATIC_LOCAL_RUNTIME_BASE_URL: readFlag(args, "--base-url"),
    UMBRATIC_LOCAL_MODEL_ID: readFlag(args, "--model"),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      if (!value) throw new Error(`${key} override cannot be empty.`);
      env[key] = value;
    }
  }
  return env;
}

function desktopEnvFromLocal(args) {
  const env = envWithOverrides(args, { ...process.env });
  return {
    ...env,
    UMBRATIC_ALLOW_ENDPOINT_EDIT: process.env.UMBRATIC_ALLOW_ENDPOINT_EDIT || "1",
    UMBRATIC_DEFAULT_ENDPOINT_MODE: "local",
    UMBRATIC_LOCAL_MODEL_ID: env.UMBRATIC_LOCAL_MODEL_ID || process.env.UMBRATIC_LOCAL_MODEL_ID || "",
    UMBRATIC_LOCAL_RUNTIME_BASE_URL:
      env.UMBRATIC_LOCAL_RUNTIME_BASE_URL || process.env.UMBRATIC_LOCAL_RUNTIME_BASE_URL || "http://127.0.0.1:11434",
  };
}

function localEnv(args) {
  if (hasFlag(args, "--help")) {
    console.log(usage());
    process.exit(0);
  }
  return {
    desktopEnv: desktopEnvFromLocal(args),
  };
}

function spawnChild(label, command, args, options) {
  let child;
  try {
    child = spawn(command, args, options);
  } catch (error) {
    console.error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  child.once("error", (error) => {
    console.error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
  return child;
}

function main() {
  const { desktopEnv } = localEnv(process.argv.slice(2));
  console.log("Starting Umbratic with packaged-app connection behavior");
  console.log(`Default local runtime: ${desktopEnv.UMBRATIC_LOCAL_RUNTIME_BASE_URL}`);
  console.log(`Default local model: ${desktopEnv.UMBRATIC_LOCAL_MODEL_ID || "configure in Settings > Connection"}`);

  const children = [];

  const desktopNpmArgs = ["--workspace", "@umbratic/desktop", "run", "dev"];
  const desktopCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const desktopArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", ["npm", ...desktopNpmArgs].join(" ")] : desktopNpmArgs;
  const desktop = spawnChild("Desktop", desktopCommand, desktopArgs, {
    cwd: repoRoot,
    env: desktopEnv,
    stdio: "inherit",
    windowsHide: false,
  });
  children.push(desktop);

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    process.exitCode = code;
  };

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  for (const child of children) {
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      if (signal) {
        shutdown(1);
        return;
      }
      shutdown(code ?? 0);
    });
  }
}

main();
