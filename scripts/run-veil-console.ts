import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
const supportedActions = new Set(["dev", "smoke", "release"]);
const commandArguments = process.argv.slice(3);

if (!action || !supportedActions.has(action)) {
  console.error("Usage: node scripts/run-veil-console.ts <dev|smoke|release> [options]");
  process.exit(2);
}

function takeOption(name) {
  const index = commandArguments.indexOf(name);
  if (index < 0) {
    return "";
  }
  const value = commandArguments[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} requires a value.`);
    process.exit(2);
  }
  commandArguments.splice(index, 2);
  return value;
}

function parsePort(name, value, fallback) {
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    console.error(`${name} must be a port from 1 to 65535.`);
    process.exit(2);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    console.error(`${name} must be a port from 1 to 65535.`);
    process.exit(2);
  }
  return port;
}

const releasePlatformOptions = ["--console-port", "--customer", "--os", "--arch", "--profile", "--dependency-dir"].flatMap((name) => { const value = takeOption(name); return value ? [name, value] : []; });

const explicitStateDir = takeOption("--state-dir");
const explicitVersion = takeOption("--version");
const explicitSeats = takeOption("--seats");
const explicitDevicesPerUser = takeOption("--devices-per-user");
const explicitSigningKeyFile = takeOption("--signing-key-file");
const explicitFeedKeyFile = takeOption("--feed-key-file");
const explicitSearchesPerMonth = takeOption("--searches-per-month");
const explicitOrgUid = takeOption("--org-uid");
const explicitConsolePort = takeOption("--port");
const explicitVeilPort = takeOption("--veil-port");
const consolePort = parsePort("--port", explicitConsolePort, 8177);
const veilPort = parsePort("--veil-port", explicitVeilPort, 8080);

function parsePositiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value || !/^\d+$/.test(value)) {
    console.error(`${name} must be a positive integer.`);
    process.exit(2);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) {
    console.error(`${name} must be between 1 and ${maximum}.`);
    process.exit(2);
  }
  return parsed;
}

// An allowance, unlike a seat count, is legitimately zero: that is the customer
// who bought no web search. The ceiling matches the one the release script
// enforces, so a typo fails here rather than after a full cross build.
function parseAllowance(name, value, maximum) {
  if (!value) {
    return 0;
  }
  if (!/^\d+$/.test(value) || Number(value) > maximum) {
    console.error(`${name} must be between 0 and ${maximum}.`);
    process.exit(2);
  }
  return Number(value);
}

if (commandArguments.length > 0) {
  console.error(`Unknown option: ${commandArguments[0]}`);
  process.exit(2);
}
if (explicitStateDir && action !== "dev") {
  console.error("--state-dir is available only for development.");
  process.exit(2);
}
if ((explicitConsolePort || explicitVeilPort) && action !== "dev") {
  console.error("--port and --veil-port are available only for development.");
  process.exit(2);
}
if (explicitVersion && action !== "release") {
  console.error("--version is available only for a release.");
  process.exit(2);
}
if (
  (explicitSeats
    || explicitDevicesPerUser
    || explicitSigningKeyFile
    || explicitFeedKeyFile
    || explicitSearchesPerMonth
    || explicitOrgUid)
  && action !== "release"
) {
  console.error(
    "--seats, --devices-per-user, --signing-key-file, --feed-key-file, --searches-per-month, and --org-uid "
    + "are available only for a release.",
  );
  process.exit(2);
}
const releaseSeats = action === "release" ? parsePositiveInteger("--seats", explicitSeats) : 0;
const releaseDevicesPerUser =
  action === "release" ? parsePositiveInteger("--devices-per-user", explicitDevicesPerUser || "2", 32) : 0;
const releaseSearchesPerMonth =
  action === "release" ? parseAllowance("--searches-per-month", explicitSearchesPerMonth, 100000000) : 0;

function windowsPathToWSL(value) {
  const resolved = path.resolve(value);
  const match = resolved.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) {
    throw new Error(`Cannot convert the repository path to a WSL path: ${resolved}`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

// Both release keys stay on this machine and are read by the build script
// running under Linux, so a Windows path has to be handed over as the WSL path
// for the same file. A value that is already absolute in Linux terms is passed
// through: on Windows that is how someone names a file inside the distribution.
function keyFilePathForLinux(value) {
  if (process.platform !== "win32") {
    return path.resolve(value);
  }
  return value.startsWith("/") ? value : windowsPathToWSL(value);
}

function defaultStateDirectory() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Umbratic", "Veil Console", "dev");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Umbratic", "Veil Console", "dev");
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "veil-console");
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal ? `${command} stopped with ${signal}` : `${command} exited with code ${code ?? 1}`));
    });
  });
}

async function buildDevelopmentBinaries(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const veilBinary = path.join(outputDirectory, executableName("veil"));
  const consoleBinary = path.join(outputDirectory, executableName("veil-console"));
  await run("go", ["build", "-trimpath", "-o", veilBinary, "./cmd/veil"], {
    cwd: path.join(root, "infrastructure", "veil"),
  });
  await run("go", ["build", "-trimpath", "-o", consoleBinary, "./cmd/veil-console"], {
    cwd: path.join(root, "infrastructure", "veil-console"),
  });
  if (process.platform !== "win32") {
    await chmod(veilBinary, 0o700);
    await chmod(consoleBinary, 0o700);
  }
  return { veilBinary, consoleBinary };
}

async function runDevelopment() {
  const stateDirectory = path.resolve(explicitStateDir || defaultStateDirectory());
  const binaryDirectory = path.join(stateDirectory, "bin");
  const { veilBinary, consoleBinary } = await buildDevelopmentBinaries(binaryDirectory);
  const consoleURL = `http://127.0.0.1:${consolePort}`;
  console.log(`Development platform: ${process.platform}-${process.arch}`);
  console.log(`State directory: ${stateDirectory}`);
  console.log(`Console URL: ${consoleURL}`);
  await run(
    consoleBinary,
    [
      "--state-dir",
      stateDirectory,
      "--veil-binary",
      veilBinary,
      "--port",
      String(consolePort),
      "--veil-address",
      `127.0.0.1:${veilPort}`,
    ],
    { cwd: stateDirectory },
  );
}

async function runLinuxWorkflow(workflow, argumentsForWorkflow = []) {
  const rootInLinux = process.platform === "win32" ? windowsPathToWSL(root) : root;
  const launcher = `${rootInLinux}/infrastructure/veil-console/scripts/run-wsl.sh`;
  const launcherArguments = [launcher, workflow];
  launcherArguments.push(...argumentsForWorkflow);
  if (process.platform === "win32") {
    await run(
      "wsl.exe",
      ["-d", process.env.WSL_DISTRO_NAME || "Ubuntu", "--", "bash", ...launcherArguments],
      { cwd: root },
    );
    return;
  }
  await run("bash", launcherArguments, { cwd: root });
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");

try {
  switch (action) {
    case "dev":
      await runDevelopment();
      break;
    case "smoke":
      await runLinuxWorkflow("smoke");
      break;
    case "release": {
      const releaseArguments = [
        "--version",
        explicitVersion || "dev",
        "--seats",
        String(releaseSeats),
        "--devices-per-user",
        String(releaseDevicesPerUser),
        "--searches-per-month",
        String(releaseSearchesPerMonth),
      ];
      if (explicitSigningKeyFile) releaseArguments.push("--signing-key-file", keyFilePathForLinux(explicitSigningKeyFile));
      if (explicitFeedKeyFile) releaseArguments.push("--feed-key-file", keyFilePathForLinux(explicitFeedKeyFile));
      if (explicitOrgUid) {
        releaseArguments.push("--org-uid", explicitOrgUid);
      }
      releaseArguments.push(...releasePlatformOptions);
      if (explicitVeilPort) releaseArguments.push("--veil-port", explicitVeilPort);
      if (process.platform === "win32") {
        await runLinuxWorkflow("release", releaseArguments);
      } else {
        await run("bash", [path.join(root, "infrastructure/veil-console/deploy/build-release-zip.sh"), ...releaseArguments]);
      }
      break;
    }
  }
} catch (error) {
  console.error(`Veil Console command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
