import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const capabilities = loadTypeScriptModule(new URL("../src/main/capabilities.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

function execError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fakeExecFile(file, args, _options, callback) {
  queueMicrotask(() => {
    if (args[0] === "-c") {
      const moduleName = args[2];
      if (moduleName === "reportlab") {
        callback(null, "4.2.0\n", "");
        return;
      }
      if (moduleName === "pypdf") {
        callback(null, "4.1.0\n", "");
        return;
      }
      if (moduleName === "pdfplumber") {
        callback(execError(3, "module not found"), "", "");
        return;
      }
    }

    const versions = new Map([
      ["fdfind", "fdfind 9.0.0\n"],
      ["git", "git version 2.45.0\n"],
      ["python3", "Python 3.12.1\n"],
      ["cl", "Microsoft (R) C/C++ Optimizing Compiler Version 19.40\n"],
      ["cc", "Apple clang version 15.0.0\n"],
      ["pdfinfo", "pdfinfo version 24.02.0\n"],
    ]);
    const output = versions.get(file);
    if (output) {
      callback(null, output, "");
      return;
    }
    callback(execError("ENOENT", `spawn ${file} ENOENT`), "", "");
  });
  return { kill: () => undefined };
}

function resolvePackage(packageName) {
  const versions = {
    "pdf-to-img": "6.0.0",
    docx: "9.1.0",
  };
  return versions[packageName]
    ? { version: versions[packageName], path: `/app/node_modules/${packageName}/package.json` }
    : null;
}

test("probeLocalCapabilities records command, package, and Python package capability states", async () => {
  const report = await capabilities.probeLocalCapabilities({
    force: true,
    runnerPath: "/app/bin/umbratic-runner",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    processVersion: "v22.0.0",
    processExecPath: "/app/node",
    env: { PATH: "" },
    execFile: fakeExecFile,
    resolvePackage,
  });

  const byId = new Map(report.probes.map((probe) => [probe.id, probe]));
  assert.equal(report.checkedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(byId.get("runner-binary").status, "available");
  assert.equal(byId.get("rg").status, "missing");
  assert.equal(byId.get("fd").status, "available");
  assert.equal(byId.get("fd").detectedCommand, "fdfind");
  assert.equal(byId.get("uv").status, "missing");
  assert.equal(byId.get("python").status, "available");
  assert.equal(byId.get("py-reportlab").status, "available");
  assert.equal(byId.get("py-pdfplumber").status, "missing");
  assert.equal(byId.get("py-pypdf").status, "available");
  assert.equal(byId.get("pdf-to-img").status, "available");
  assert.equal(byId.get("node-docx").status, "available");
  assert.equal(byId.get("node-pptx").status, "missing");
  assert.equal(byId.get("pdftoppm").status, "missing");
  assert.equal(byId.get("tesseract").status, "missing");
  assert.equal(byId.get("pdfinfo").status, "available");
  assert.equal(report.summary.requiredMissing, 0);
  assert.ok(report.summary.recommendedMissing >= 1);
});

test("capability guidance degrades Python, CMake, and artifact workflows when probes are missing", async () => {
  const report = await capabilities.probeLocalCapabilities({
    force: true,
    runnerPath: "/app/bin/umbratic-runner",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    env: { PATH: "" },
    execFile: fakeExecFile,
    resolvePackage,
  });

  const promptGuidance = capabilities.capabilityPromptGuidance(report, {
    python: true,
    cmake: true,
    artifacts: true,
    ocr: true,
  });
  assert.match(promptGuidance, /Local capability facts/);
  assert.match(promptGuidance, /search fallbacks are available when rg is missing/);
  assert.match(promptGuidance, /Python uv runtime: missing/);
  assert.match(promptGuidance, /CMake: missing; Ninja: missing; compiler: available/);
  assert.match(promptGuidance, /PDF render QA with Poppler: missing or incomplete/);
  assert.match(promptGuidance, /JS artifact authoring packages missing: node-pptx, node-xlsx/);
  assert.match(promptGuidance, /local OCR digest generation is unavailable/);
});

test("capabilityTelemetrySnapshot keeps redacted facts and marks missing capabilities that affect a run", async () => {
  const report = await capabilities.probeLocalCapabilities({
    force: true,
    runnerPath: "/app/bin/umbratic-runner",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    processVersion: "v22.0.0",
    processExecPath: "/private/app/node",
    env: { PATH: "" },
    execFile: fakeExecFile,
    resolvePackage,
  });

  const snapshot = capabilities.capabilityTelemetrySnapshot(report, { python: true, artifacts: true, ocr: true });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /executablePath/);
  assert.doesNotMatch(serialized, /\/private\/app\/node/);

  const byId = new Map(snapshot.map((probe) => [probe.id, probe]));
  assert.deepEqual(plain(byId.get("uv")), {
    id: "uv",
    status: "missing",
    category: "recommended",
    importance: "recommended",
    workflows: ["Python", "artifacts"],
    affectedCurrentRun: true,
  });
  assert.equal(byId.get("python").versionFamily, "3.12");
  assert.equal(byId.get("pdftoppm").affectedCurrentRun, true);
  assert.equal(byId.get("tesseract").affectedCurrentRun, true);
  assert.equal(byId.get("node-runtime").versionFamily, "22.0");
});

