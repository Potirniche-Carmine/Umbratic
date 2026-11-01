// One builder process spans all three official SignPath artifact requests.
// In particular, the signed NSIS uninstaller is embedded without rebuilding it.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applySigningResponse, repository, signingRoot, stages } from "./windows-signing.ts";

const [command, phase] = process.argv.slice(2);
const root = command === "stop" && !process.env.UMBRATIC_SIGNPATH_STAGING
  ? path.join(process.env.RUNNER_TEMP!, "umbratic-signpath") : signingRoot();
function stage() {
  if (!stages.includes(phase as typeof stages[number])) throw new Error("Invalid SignPath stage.");
  return path.join(root, phase);
}
function status(): { code: number | null; signal: string | null; error?: string } | null {
  const file = path.join(root, "exit.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function workerAlive(): boolean {
  const pid = Number(fs.readFileSync(path.join(root, "pid"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid signing worker PID.");
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function buildError(): Error {
  const log = path.join(root, "build.log");
  let tail = "";
  if (fs.existsSync(log)) {
    const fd = fs.openSync(log, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 16_000));
      fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      tail = bytes.toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  return new Error(`SignPath packaging stopped: ${JSON.stringify(status())}\n${tail}`);
}

if (command === "start") {
  if (fs.existsSync(root)) throw new Error("Signing staging directory already exists; refuse stale responses.");
  fs.mkdirSync(root, { recursive: true });
  const log = fs.openSync(path.join(root, "build.log"), "wx");
  const environment = { ...process.env };
  // Signing approval is exclusively in the official workflow action. The
  // build process has no signing/API/GitHub credential capability.
  for (const key of Object.keys(environment)) if (/TOKEN|SECRET|PASSWORD|APPLE_|MACOS_CERTIFICATE/i.test(key)) delete environment[key];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker"], {
    cwd: repository, detached: true, stdio: ["ignore", log, log], env: environment, windowsHide: true,
  });
  if (!child.pid) throw new Error("Unable to start Windows packaging.");
  fs.writeFileSync(path.join(root, "pid"), String(child.pid));
  fs.closeSync(log);
  child.unref();
} else if (command === "worker") {
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!fs.existsSync(npm)) throw new Error("Pinned npm executable is missing.");
  const child = spawn(process.execPath, [npm, "run", "desktop:release"], { cwd: repository, stdio: "inherit", windowsHide: true });
  const completed = (result: { code: number | null; signal: string | null; error?: string }) => {
    const temporary = path.join(root, "exit.tmp");
    fs.writeFileSync(temporary, JSON.stringify(result));
    fs.renameSync(temporary, path.join(root, "exit.json"));
  };
  child.once("error", () => completed({ code: null, signal: null, error: "Unable to launch packaging" }));
  child.once("exit", (code, signal) => {
    completed({ code, signal });
    process.exitCode = code ?? 1;
  });
} else if (command === "wait") {
  const ready = path.join(stage(), "ready");
  const deadline = Date.now() + ({ payload: 60, uninstaller: 20, installer: 15 }[phase] * 60_000);
  let heartbeat = 0;
  while (!fs.existsSync(ready)) {
    if (status() || !workerAlive()) throw buildError();
    if (Date.now() > deadline) throw new Error(`Windows ${phase} preparation timed out.`);
    if (Date.now() > heartbeat) {
      console.log(`Waiting for the ${phase} signing artifact; builder is still running.`);
      heartbeat = Date.now() + 30_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`Prepared ${phase} for the official GitHub artifact signing request.`);
} else if (command === "resume") {
  stage();
  applySigningResponse(phase as typeof stages[number]);
} else if (command === "finish") {
  const deadline = Date.now() + 15 * 60_000;
  while (!status()) {
    if (!workerAlive()) throw buildError();
    if (Date.now() > deadline) throw new Error("Final Windows package verification timed out.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status()!.code !== 0 || status()!.signal) throw buildError();
  console.log("Windows packaging and native smoke tests completed after all three signing stages.");
} else if (command === "stop") {
  const pidFile = path.join(root, "pid");
  if (fs.existsSync(pidFile) && !status()) {
    const pid = fs.readFileSync(pidFile, "utf8");
    if (!/^\d+$/.test(pid)) throw new Error("Invalid signing worker PID.");
    const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16_000 });
    if (result.error || (result.status !== 0 && result.status !== 128)) throw new Error("Unable to stop the signing worker process tree.");
  }
  if (fs.existsSync(pidFile)) {
    const deadline = Date.now() + 10_000;
    while (workerAlive()) {
      if (Date.now() > deadline) throw new Error("Signing worker did not exit; preserving its control state for cleanup.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  // No private signing key is present locally. Remove request/response copies
  // as well, so a retry cannot consume a previous approval.
  fs.rmSync(root, { recursive: true, force: true });
} else throw new Error("Unknown Windows signing lifecycle command.");
