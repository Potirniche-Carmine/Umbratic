import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { resolveInstalledElectron } from "../apps/desktop/scripts/electron-runtime.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = positiveInteger(process.env.UMBRATIC_BENCH_SAMPLES, 10);
const settleMs = positiveInteger(process.env.UMBRATIC_BENCH_SETTLE_MS, 500);
const label = process.env.UMBRATIC_BENCH_LABEL || "electron-typescript";
const outputPath = process.env.UMBRATIC_BENCH_OUTPUT
  ? path.resolve(process.env.UMBRATIC_BENCH_OUTPUT)
  : null;
const desktopCommand = process.env.UMBRATIC_BENCH_DESKTOP
  ? path.resolve(process.env.UMBRATIC_BENCH_DESKTOP)
  : resolveInstalledElectron();
const desktopArgs = process.env.UMBRATIC_BENCH_DESKTOP_ARGS
  ? JSON.parse(process.env.UMBRATIC_BENCH_DESKTOP_ARGS)
  : [path.join(root, "apps/desktop")];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    mean: Number(mean.toFixed(3)),
    median: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    min: Number(Math.min(...values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(filePath, child, timeoutMs = 20_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    if (child.exitCode !== null) throw new Error(`Desktop exited before loading the renderer with code ${child.exitCode}.`);
    await delay(10);
  }
  throw new Error("Timed out waiting for the desktop renderer to load.");
}

async function processRows() {
  const child = spawn("ps", ["-axo", "pid=,ppid=,rss=,command="], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for await (const chunk of child.stdout) output += chunk.toString("utf8");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) return [];
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4] }] : [];
  });
}

async function processTree(rootPid) {
  const rows = await processRows();
  const selected = new Map();
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.pop();
    if (selected.has(pid)) continue;
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) selected.set(pid, row);
    for (const child of rows.filter((candidate) => candidate.ppid === pid)) pending.push(child.pid);
  }
  return [...selected.values()];
}

async function closeProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
  }
  return total;
}

async function sampleDesktop(index) {
  const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), `umbratic-desktop-benchmark-${index}-`));
  const marker = path.join(sampleRoot, "loaded.json");
  const userData = path.join(sampleRoot, "user-data");
  const startedAt = performance.now();
  const child = spawn(desktopCommand, desktopArgs, {
    cwd: root,
    env: {
      ...process.env,
      UMBRATIC_BENCHMARK_FILE: marker,
      UMBRATIC_USER_DATA_DIR: userData,
      UMBRATIC_ALLOW_ENDPOINT_EDIT: "1",
      // Keep Veil out of the measured process tree. It is unchanged by this
      // benchmark and development mode otherwise compiles it with `go run`.
      UMBRATIC_MANAGED_ENDPOINT_MODE: "server",
      UMBRATIC_VEIL_BASE_URL: "https://127.0.0.1:9",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    const markerValue = await waitForJson(marker, child);
    const externalStartupMs = performance.now() - startedAt;
    await delay(settleMs);
    const tree = await processTree(child.pid);
    return {
      externalStartupMs,
      rendererLoadedMs: markerValue.rendererLoadedMs,
      rssBytes: tree.reduce((sum, row) => sum + row.rssBytes, 0),
      processCount: tree.length,
      processRoles: tree.map((row) => row.command.match(/--type=([^ ]+)/)?.[1] || "browser"),
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  } finally {
    await closeProcess(child);
    fs.rmSync(sampleRoot, { recursive: true, force: true });
  }
}

async function main() {
  const values = [];
  for (let index = 0; index < samples; index += 1) values.push(await sampleDesktop(index));
  const result = {
    label,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    command: [path.relative(root, desktopCommand) || desktopCommand, ...desktopArgs.map((arg) => path.relative(root, arg) || arg)],
    workloads: {
      processToRendererLoadedMs: stats(values.map((value) => value.externalStartupMs)),
      mainModuleToRendererLoadedMs: stats(values.map((value) => value.rendererLoadedMs)),
    },
    process: {
      settledRssBytes: stats(values.map((value) => value.rssBytes)),
      processCount: stats(values.map((value) => value.processCount)),
      roles: [...new Set(values.flatMap((value) => value.processRoles))].sort(),
    },
    artifacts: {
      electronRuntimeBytes: directoryBytes(path.join(root, "node_modules/electron/dist/Electron.app")),
      desktopRendererBytes: directoryBytes(path.join(root, "apps/desktop/dist")),
      desktopMainBytes: directoryBytes(path.join(root, "apps/desktop/dist-electron")),
    },
    parameters: { samples, settleMs },
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text, "utf8");
  }
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

