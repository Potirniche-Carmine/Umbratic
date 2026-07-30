import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeReport,
  CapabilityProbeResult,
  CapabilityProbeStatus,
  CapabilityTelemetryProbe,
} from "./types";

const nodeRequire = createRequire(__filename);
const defaultCommandTimeoutMs = 1200;
const probeCacheTtlMs = 30000;

type ExecFileLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: (
    error: (Error & { code?: string | number; signal?: NodeJS.Signals; killed?: boolean }) | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => unknown;

type ExecOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
  errorMessage?: string;
};

type PackageResolveResult = { version?: string; path?: string } | null | undefined;

export type CapabilityProbeOptions = {
  force?: boolean;
  runnerPath?: string | null;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileLike;
  resolvePackage?: (packageName: string) => PackageResolveResult;
  commandTimeoutMs?: number;
  platform?: NodeJS.Platform;
  processVersion?: string;
  processExecPath?: string;
};

type CommandProbeSpec = {
  id: string;
  label: string;
  category: CapabilityProbeCategory;
  importance: CapabilityProbeImportance;
  commands: string[];
  versionArgs?: string[];
  purpose: string;
  installHint: string;
  workflows: string[];
  acceptNonZeroAsAvailable?: boolean;
};

type NodePackageProbeSpec = {
  id: string;
  label: string;
  packageName: string;
  category: CapabilityProbeCategory;
  importance: CapabilityProbeImportance;
  purpose: string;
  installHint: string;
  workflows: string[];
};

type PythonPackageProbeSpec = {
  id: string;
  label: string;
  moduleName: string;
  distributionName: string;
  category: CapabilityProbeCategory;
  importance: CapabilityProbeImportance;
  purpose: string;
  installHint: string;
  workflows: string[];
};

export type CapabilityPromptNeeds = {
  python?: boolean;
  cmake?: boolean;
  artifacts?: boolean;
  ocr?: boolean;
};

let cachedReport: { expiresAt: number; report: CapabilityProbeReport } | null = null;

function checkedAt(options: CapabilityProbeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function baseProbe(
  spec: Pick<CapabilityProbeResult, "id" | "label" | "category" | "importance" | "purpose" | "installHint" | "workflows">,
  status: CapabilityProbeStatus,
  at: string,
  extra: Partial<CapabilityProbeResult> = {},
): CapabilityProbeResult {
  return {
    id: spec.id,
    label: spec.label,
    category: spec.category,
    importance: spec.importance,
    status,
    purpose: spec.purpose,
    installHint: spec.installHint,
    workflows: spec.workflows,
    checkedAt: at,
    ...extra,
  };
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env[pathKey(env)] ?? "";
  const entries = raw.split(path.delimiter).filter(Boolean);
  const localBin = path.join(os.homedir(), ".local", "bin");
  return entries.includes(localBin) ? entries : [localBin, ...entries];
}

function executableNames(command: string, platform: NodeJS.Platform): string[] {
  if (path.basename(command) !== command) return [command];
  if (platform !== "win32" || path.extname(command)) return [command];
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`), ...pathext.map((ext) => `${command}${ext.toUpperCase()}`)];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findExecutablePath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const names = executableNames(command, platform);
  if (path.basename(command) !== command) {
    const resolved = path.resolve(command);
    return isFile(resolved) ? resolved : undefined;
  }
  for (const directory of pathEntries(env)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function normalizeOutput(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function firstVersionLine(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((part) => part.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : undefined;
}

function compactErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || undefined;
}

async function runExecFile(
  file: string,
  args: string[],
  options: CapabilityProbeOptions,
): Promise<ExecOutcome> {
  const execFileImpl = options.execFile ?? (execFile as unknown as ExecFileLike);
  return new Promise((resolve) => {
    execFileImpl(
      file,
      args,
      {
        env: options.env ?? process.env,
        timeout: options.commandTimeoutMs ?? defaultCommandTimeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdoutValue, stderrValue) => {
        const stdout = normalizeOutput(stdoutValue);
        const stderr = normalizeOutput(stderrValue);
        if (!error) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        resolve({
          ok: false,
          stdout,
          stderr,
          code: error.code,
          errorMessage: compactErrorMessage(error.message),
        });
      },
    );
  });
}

async function probeCommand(spec: CommandProbeSpec, options: CapabilityProbeOptions): Promise<CapabilityProbeResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const at = checkedAt(options);
  for (const command of spec.commands) {
    const executablePath = findExecutablePath(command, env, platform);
    const result = await runExecFile(executablePath ?? command, spec.versionArgs ?? ["--version"], options);
    if (result.ok) {
      return baseProbe(spec, "available", at, {
        version: firstVersionLine(result.stdout, result.stderr),
        executablePath,
        detectedCommand: command,
      });
    }
    if (result.code === "ENOENT") {
      continue;
    }
    if (spec.acceptNonZeroAsAvailable && (executablePath || result.stdout || result.stderr)) {
      return baseProbe(spec, "available", at, {
        version: firstVersionLine(result.stdout, result.stderr),
        executablePath,
        detectedCommand: command,
        message: result.errorMessage,
      });
    }
    return baseProbe(spec, "error", at, {
      executablePath,
      detectedCommand: command,
      message: result.errorMessage ?? firstVersionLine(result.stdout, result.stderr) ?? "Version probe failed.",
    });
  }
  return baseProbe(spec, "missing", at, {
    message: `None of these commands were found: ${spec.commands.join(", ")}.`,
  });
}

function packageJsonFromResolvedModule(resolvedModule: string): string | undefined {
  let directory = path.dirname(resolvedModule);
  for (let index = 0; index < 5; index += 1) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function defaultResolvePackage(packageName: string): PackageResolveResult {
  try {
    const packageJson = nodeRequire.resolve(`${packageName}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version?: unknown };
    return { path: packageJson, version: typeof parsed.version === "string" ? parsed.version : undefined };
  } catch {
    try {
      const resolvedModule = nodeRequire.resolve(packageName);
      const packageJson = packageJsonFromResolvedModule(resolvedModule);
      if (!packageJson) return { path: resolvedModule };
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version?: unknown };
      return { path: packageJson, version: typeof parsed.version === "string" ? parsed.version : undefined };
    } catch {
      return null;
    }
  }
}

function probeNodePackage(spec: NodePackageProbeSpec, options: CapabilityProbeOptions): CapabilityProbeResult {
  const at = checkedAt(options);
  const resolved = (options.resolvePackage ?? defaultResolvePackage)(spec.packageName);
  if (resolved) {
    return baseProbe(spec, "available", at, {
      version: resolved.version ? `${spec.packageName} ${resolved.version}` : spec.packageName,
      executablePath: resolved.path,
    });
  }
  return baseProbe(spec, "missing", at, {
    message: `${spec.packageName} is not available to the desktop runtime.`,
  });
}

async function probePythonPackage(
  spec: PythonPackageProbeSpec,
  pythonCommand: string | undefined,
  options: CapabilityProbeOptions,
): Promise<CapabilityProbeResult> {
  const at = checkedAt(options);
  if (!pythonCommand) {
    return baseProbe(spec, "unknown", at, {
      message: "No Python command was available for package inspection.",
    });
  }
  const code = [
    "import importlib.metadata, importlib.util, sys",
    "module_name = sys.argv[1]",
    "dist_name = sys.argv[2]",
    "sys.exit(3) if importlib.util.find_spec(module_name) is None else None",
    "try:",
    "    print(importlib.metadata.version(dist_name))",
    "except importlib.metadata.PackageNotFoundError:",
    "    print('available')",
  ].join("\n");
  const result = await runExecFile(pythonCommand, ["-c", code, spec.moduleName, spec.distributionName], options);
  if (result.ok) {
    const version = firstVersionLine(result.stdout, result.stderr);
    return baseProbe(spec, "available", at, {
      version: version ? `${spec.distributionName} ${version}` : spec.distributionName,
      detectedCommand: pythonCommand,
    });
  }
  if (result.code === 3) {
    return baseProbe(spec, "missing", at, {
      detectedCommand: pythonCommand,
      message: `${spec.moduleName} is not importable in the detected Python environment.`,
    });
  }
  return baseProbe(spec, "error", at, {
    detectedCommand: pythonCommand,
    message: result.errorMessage ?? firstVersionLine(result.stdout, result.stderr) ?? "Python package probe failed.",
  });
}

function staticProbe(
  spec: Pick<CapabilityProbeResult, "id" | "label" | "category" | "importance" | "purpose" | "installHint" | "workflows">,
  status: CapabilityProbeStatus,
  options: CapabilityProbeOptions,
  extra: Partial<CapabilityProbeResult> = {},
): CapabilityProbeResult {
  return baseProbe(spec, status, checkedAt(options), extra);
}

function nodeRuntimeProbe(options: CapabilityProbeOptions): CapabilityProbeResult {
  return staticProbe(
    {
      id: "node-runtime",
      label: "Node runtime",
      category: "required",
      importance: "required",
      purpose: "Runs the Electron desktop process and local TypeScript/JavaScript harness code.",
      installHint: "Use the bundled desktop runtime or install the supported Node version for development.",
      workflows: ["desktop", "runner", "JavaScript"],
    },
    "available",
    options,
    {
      version: `Node ${options.processVersion ?? process.version}`,
      executablePath: options.processExecPath ?? process.execPath,
    },
  );
}

function runnerBinaryProbe(options: CapabilityProbeOptions): CapabilityProbeResult {
  const runnerPath = options.runnerPath ?? null;
  return staticProbe(
    {
      id: "runner-binary",
      label: "Umbratic runner",
      category: "required",
      importance: "required",
      purpose: "Starts local workspace tools for read, search, write, edit, and command execution.",
      installHint: "Build the runner workspace before starting tasks.",
      workflows: ["runner", "workspace tools"],
    },
    runnerPath ? "available" : "missing",
    options,
    runnerPath
      ? { version: "built", executablePath: runnerPath }
      : { message: "The runner CLI was not found in the app bundle or development workspace." },
  );
}

function workspaceToolsProbe(options: CapabilityProbeOptions): CapabilityProbeResult {
  return staticProbe(
    {
      id: "workspace-tools",
      label: "Workspace tool surface",
      category: "required",
      importance: "required",
      purpose: "Provides the model-visible read, search, write, edit, and command tools.",
      installHint: "Build and start the runner if workspace tools are unavailable.",
      workflows: ["read", "search", "write", "edit", "command"],
    },
    "available",
    options,
    { version: "read/search/write/edit/command" },
  );
}

const commandProbeSpecs: CommandProbeSpec[] = [
  {
    id: "rg",
    label: "ripgrep",
    category: "recommended",
    importance: "recommended",
    commands: ["rg"],
    purpose: "Fast text search in workspaces.",
    installHint: "Install ripgrep with your system package manager.",
    workflows: ["workspace search", "engineering"],
  },
  {
    id: "fd",
    label: "fd",
    category: "recommended",
    importance: "recommended",
    commands: ["fd", "fdfind"],
    purpose: "Fast path discovery in workspaces.",
    installHint: "Install fd with your system package manager; some Linux distributions package it as fdfind.",
    workflows: ["workspace search", "path discovery"],
  },
  {
    id: "git",
    label: "Git",
    category: "recommended",
    importance: "recommended",
    commands: ["git"],
    purpose: "Reads repository status, diffs, branches, and worktree metadata.",
    installHint: "Install Git with your system package manager or platform developer tools.",
    workflows: ["Git", "worktree review", "engineering"],
  },
  {
    id: "npm",
    label: "npm",
    category: "recommended",
    importance: "recommended",
    commands: ["npm"],
    purpose: "Runs the repository's declared Node scripts and verification gates.",
    installHint: "Install the supported Node.js release, which includes npm.",
    workflows: ["JavaScript", "TypeScript", "verification"],
    acceptNonZeroAsAvailable: true,
  },
  {
    id: "typescript-language-server",
    label: "TypeScript language server",
    category: "optional-engineering",
    importance: "optional",
    commands: ["typescript-language-server"],
    purpose: "Provides TypeScript and JavaScript definitions, references, hover information, and symbols.",
    installHint: "Install typescript-language-server and TypeScript, then make the command available on PATH.",
    workflows: ["code intelligence", "TypeScript", "JavaScript"],
  },
  {
    id: "rust-analyzer",
    label: "rust-analyzer",
    category: "optional-engineering",
    importance: "optional",
    commands: ["rust-analyzer"],
    purpose: "Provides Rust definitions, references, hover information, and symbols.",
    installHint: "Install rust-analyzer with rustup or your system package manager.",
    workflows: ["code intelligence", "Rust"],
  },
  {
    id: "uv",
    label: "uv",
    category: "recommended",
    importance: "recommended",
    commands: ["uv"],
    purpose: "Creates repeatable Python environments and runs dependency-heavy Python verification.",
    installHint: "Install uv from the uv installer or your system package manager.",
    workflows: ["Python", "artifacts"],
  },
  {
    id: "python",
    label: "Python",
    category: "optional-engineering",
    importance: "optional",
    commands: ["python3", "python", "py"],
    purpose: "Supports simple Python inspection and package availability probes.",
    installHint: "Install Python with your platform package manager or through uv.",
    workflows: ["Python", "analysis"],
  },
  {
    id: "cmake",
    label: "CMake",
    category: "optional-engineering",
    importance: "optional",
    commands: ["cmake"],
    purpose: "Configures C and C++ projects when the workspace uses CMake.",
    installHint: "Install CMake with your system package manager or platform developer tools.",
    workflows: ["C/C++ build", "CMake"],
  },
  {
    id: "ninja",
    label: "Ninja",
    category: "optional-engineering",
    importance: "optional",
    commands: ["ninja", "ninja-build"],
    purpose: "Build backend commonly used with CMake.",
    installHint: "Install Ninja with your system package manager.",
    workflows: ["C/C++ build", "CMake"],
  },
  {
    id: "compiler",
    label: "Compiler toolchain",
    category: "optional-engineering",
    importance: "optional",
    commands: process.platform === "win32" ? ["cl", "clang", "gcc"] : ["cc", "clang", "gcc"],
    purpose: "Compiles C and C++ code for build verification.",
    installHint: "Install platform developer tools or a C/C++ compiler package.",
    workflows: ["C/C++ build", "compiler"],
    acceptNonZeroAsAvailable: true,
  },
  {
    id: "tree-sitter",
    label: "tree-sitter",
    category: "optional-engineering",
    importance: "optional",
    commands: ["tree-sitter"],
    purpose: "Enables syntax-aware source inspection when grammars are available.",
    installHint: "Install tree-sitter with your system package manager when syntax-aware inspection is useful.",
    workflows: ["source inspection", "engineering"],
  },
  {
    id: "bat",
    label: "bat",
    category: "optional-engineering",
    importance: "optional",
    commands: ["bat", "batcat"],
    purpose: "Readable file previews in local diagnostics.",
    installHint: "Install bat with your system package manager; some Linux distributions package it as batcat.",
    workflows: ["file preview", "engineering"],
  },
  {
    id: "jq",
    label: "jq",
    category: "optional-engineering",
    importance: "optional",
    commands: ["jq"],
    purpose: "Inspects and transforms JSON from local files and command output.",
    installHint: "Install jq with your system package manager.",
    workflows: ["JSON", "engineering"],
  },
  {
    id: "yq",
    label: "yq",
    category: "optional-engineering",
    importance: "optional",
    commands: ["yq"],
    purpose: "Inspects and transforms YAML from local files and command output.",
    installHint: "Install yq with your system package manager.",
    workflows: ["YAML", "engineering"],
  },
  {
    id: "pdftoppm",
    label: "Poppler pdftoppm",
    category: "optional-artifacts",
    importance: "optional",
    commands: ["pdftoppm"],
    purpose: "Renders PDF pages to images for visual QA.",
    installHint: "Install Poppler with your system package manager.",
    workflows: ["PDF artifact", "visual QA"],
  },
  {
    id: "tesseract",
    label: "Tesseract OCR",
    category: "optional-artifacts",
    importance: "optional",
    commands: ["tesseract"],
    purpose: "Runs local OCR for image and scanned-PDF attachment digests.",
    installHint: "Install Tesseract OCR locally and make the tesseract command available on PATH.",
    workflows: ["OCR artifact", "image attachment", "scanned PDF"],
  },
  {
    id: "pdfinfo",
    label: "Poppler pdfinfo",
    category: "optional-artifacts",
    importance: "optional",
    commands: ["pdfinfo"],
    purpose: "Reads PDF metadata and page counts before rendering or extraction.",
    installHint: "Install Poppler with your system package manager.",
    workflows: ["PDF artifact", "visual QA"],
  },
  {
    id: "libreoffice",
    label: "LibreOffice",
    category: "optional-artifacts",
    importance: "optional",
    commands: ["soffice", "libreoffice"],
    purpose: "Renders or exports DOCX, PPTX, and spreadsheet artifacts for visual checks.",
    installHint: "Install LibreOffice or make soffice available on PATH.",
    workflows: ["DOCX artifact", "PPTX artifact", "XLSX artifact", "visual QA"],
  },
];

const nodePackageProbeSpecs: NodePackageProbeSpec[] = [
  {
    id: "pdf-to-img",
    label: "pdf-to-img",
    packageName: "pdf-to-img",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Renders PDF attachments to image input for vision-capable models.",
    installHint: "Install the desktop dependencies so pdf-to-img is available.",
    workflows: ["PDF attachment", "vision input"],
  },
  {
    id: "node-docx",
    label: "DOCX JS runtime",
    packageName: "docx",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Creates DOCX files through a deterministic JavaScript artifact runtime.",
    installHint: "Add the configured DOCX artifact package to the desktop runtime.",
    workflows: ["DOCX artifact"],
  },
  {
    id: "node-pptx",
    label: "PPTX JS runtime",
    packageName: "pptxgenjs",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Creates PowerPoint files through a deterministic JavaScript artifact runtime.",
    installHint: "Add the configured PPTX artifact package to the desktop runtime.",
    workflows: ["PPTX artifact"],
  },
  {
    id: "node-xlsx",
    label: "XLSX JS runtime",
    packageName: "xlsx",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Creates and inspects spreadsheet workbooks through a JavaScript artifact runtime.",
    installHint: "Add the configured XLSX artifact package to the desktop runtime.",
    workflows: ["XLSX artifact"],
  },
];

const pythonPackageProbeSpecs: PythonPackageProbeSpec[] = [
  {
    id: "py-reportlab",
    label: "reportlab",
    moduleName: "reportlab",
    distributionName: "reportlab",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Generates PDF files locally.",
    installHint: "Install reportlab into the configured Python artifact environment.",
    workflows: ["PDF artifact"],
  },
  {
    id: "py-pdfplumber",
    label: "pdfplumber",
    moduleName: "pdfplumber",
    distributionName: "pdfplumber",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Extracts text and tables from PDFs for content checks.",
    installHint: "Install pdfplumber into the configured Python artifact environment.",
    workflows: ["PDF artifact", "PDF extraction"],
  },
  {
    id: "py-pypdf",
    label: "pypdf",
    moduleName: "pypdf",
    distributionName: "pypdf",
    category: "optional-artifacts",
    importance: "optional",
    purpose: "Reads and manipulates PDFs for local artifact workflows.",
    installHint: "Install pypdf into the configured Python artifact environment.",
    workflows: ["PDF artifact", "PDF extraction"],
  },
];

function reportSummary(probes: CapabilityProbeResult[]): CapabilityProbeReport["summary"] {
  return probes.reduce<CapabilityProbeReport["summary"]>(
    (summary, probe) => {
      summary[probe.status] += 1;
      if (probe.status !== "available") {
        if (probe.importance === "required") summary.requiredMissing += 1;
        if (probe.importance === "recommended") summary.recommendedMissing += 1;
        if (probe.importance === "optional") summary.optionalMissing += 1;
      }
      return summary;
    },
    {
      available: 0,
      missing: 0,
      error: 0,
      unknown: 0,
      requiredMissing: 0,
      recommendedMissing: 0,
      optionalMissing: 0,
    },
  );
}

export async function probeLocalCapabilities(options: CapabilityProbeOptions = {}): Promise<CapabilityProbeReport> {
  if (!options.force && cachedReport && cachedReport.expiresAt > Date.now()) {
    return cachedReport.report;
  }

  const nodeProbe = nodeRuntimeProbe(options);
  const runnerProbe = runnerBinaryProbe(options);
  const workspaceProbe = workspaceToolsProbe(options);
  const pythonSpec = commandProbeSpecs.find((spec) => spec.id === "python");
  if (!pythonSpec) {
    throw new Error("Python probe spec is missing.");
  }
  const pythonProbePromise = probeCommand(pythonSpec, options);
  const commandProbePromises = commandProbeSpecs
    .filter((spec) => spec.id !== "python")
    .map((spec) => probeCommand(spec, options));
  const nodePackageProbes = nodePackageProbeSpecs.map((spec) => probeNodePackage(spec, options));
  const pythonProbe = await pythonProbePromise;
  const pythonPackageProbes = await Promise.all(
    pythonPackageProbeSpecs.map((spec) => probePythonPackage(spec, pythonProbe.detectedCommand, options)),
  );
  const commandProbes = await Promise.all(commandProbePromises);

  const probes = [
    nodeProbe,
    runnerProbe,
    workspaceProbe,
    ...commandProbes.slice(0, 4),
    pythonProbe,
    ...commandProbes.slice(4),
    ...nodePackageProbes,
    ...pythonPackageProbes,
  ];
  const report = {
    checkedAt: checkedAt(options),
    probes,
    summary: reportSummary(probes),
  };
  cachedReport = { expiresAt: Date.now() + probeCacheTtlMs, report };
  return report;
}

export function capabilityById(report: CapabilityProbeReport, id: string): CapabilityProbeResult | undefined {
  return report.probes.find((probe) => probe.id === id);
}

function isAvailable(report: CapabilityProbeReport, id: string): boolean {
  return capabilityById(report, id)?.status === "available";
}

function statusLabel(probe: CapabilityProbeResult | undefined): string {
  if (!probe) return "unknown";
  return probe.version && probe.status === "available" ? `available (${probe.version})` : probe.status;
}

function missingRequiredLabels(report: CapabilityProbeReport): string[] {
  return report.probes
    .filter((probe) => probe.importance === "required" && probe.status !== "available")
    .map((probe) => probe.label);
}

function artifactRequested(needs: CapabilityPromptNeeds): boolean {
  return !!needs.artifacts;
}

export function capabilityPromptGuidance(report: CapabilityProbeReport, needs: CapabilityPromptNeeds): string {
  const lines = [
    "Local capability facts:",
    `- checked at ${report.checkedAt}`,
  ];
  const requiredMissing = missingRequiredLabels(report);
  const languageServers = ["typescript-language-server", "rust-analyzer"]
    .map((id) => capabilityById(report, id))
    .filter((probe): probe is CapabilityProbeResult => probe?.status === "available")
    .map((probe) => probe.label);
  if (languageServers.length > 0) {
    lines.push(`- LSP code intelligence is available: ${languageServers.join(", ")}`);
  }
  if (requiredMissing.length) {
    lines.push(`- setup problem: missing required capability ${requiredMissing.join(", ")}`);
  }

  const rg = capabilityById(report, "rg");
  const fd = capabilityById(report, "fd");
  lines.push(`- workspace text search helper: ${statusLabel(rg)}`);
  lines.push(`- workspace path discovery helper: ${statusLabel(fd)}`);
  if (rg?.status !== "available") {
    lines.push("- search fallbacks are available when rg is missing.");
  }
  if (fd?.status !== "available") {
    lines.push("- path discovery fallbacks are available when fd/fdfind is missing.");
  }

  if (needs.python) {
    const uv = capabilityById(report, "uv");
    const python = capabilityById(report, "python");
    lines.push(`- Python uv runtime: ${statusLabel(uv)}`);
    lines.push(`- Python interpreter probe: ${statusLabel(python)}`);
  }

  if (needs.cmake) {
    const cmake = capabilityById(report, "cmake");
    const ninja = capabilityById(report, "ninja");
    const compiler = capabilityById(report, "compiler");
    lines.push(`- CMake: ${statusLabel(cmake)}; Ninja: ${statusLabel(ninja)}; compiler: ${statusLabel(compiler)}`);
  }

  if (artifactRequested(needs)) {
    const popplerRenderAvailable = isAvailable(report, "pdftoppm") && isAvailable(report, "pdfinfo");
    const libreOfficeAvailable = isAvailable(report, "libreoffice");
    const pdfPackageAvailable = isAvailable(report, "py-reportlab") && (isAvailable(report, "py-pdfplumber") || isAvailable(report, "py-pypdf"));
    const jsArtifactPackages = ["node-docx", "node-pptx", "node-xlsx"].filter((id) => !isAvailable(report, id));
    lines.push(`- PDF render QA with Poppler: ${popplerRenderAvailable ? "available" : "missing or incomplete"}`);
    lines.push(`- PDF Python packages: ${pdfPackageAvailable ? "available" : "missing or incomplete"}`);
    lines.push(`- DOCX/PPTX/XLSX render/export with LibreOffice: ${libreOfficeAvailable ? "available" : "missing"}`);
    if (jsArtifactPackages.length) {
      lines.push(`- JS artifact authoring packages missing: ${jsArtifactPackages.join(", ")}`);
    }
  }

  if (needs.ocr) {
    const tesseract = capabilityById(report, "tesseract");
    const pdfToImg = capabilityById(report, "pdf-to-img");
    lines.push(`- local OCR engine: ${statusLabel(tesseract)}`);
    lines.push(`- PDF-to-image support for OCR: ${statusLabel(pdfToImg)}`);
    if (tesseract?.status !== "available") {
      lines.push("- local OCR digest generation is unavailable.");
    }
  }

  return lines.join("\n");
}

function versionFamily(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const numeric = version.match(/\d+(?:\.\d+)?/);
  if (numeric) return numeric[0];
  return version.split(/\s+/).slice(0, 2).join(" ").slice(0, 48) || undefined;
}

function affectedCurrentRun(probe: CapabilityProbeResult, needs: CapabilityPromptNeeds): boolean | undefined {
  if (probe.status === "available") return undefined;
  if (probe.importance === "required") return true;
  if ((probe.id === "rg" || probe.id === "fd") && (needs.python || needs.cmake || needs.artifacts)) return true;
  if (needs.python && ["uv", "python"].includes(probe.id)) return true;
  if (needs.cmake && ["cmake", "ninja", "compiler"].includes(probe.id)) return true;
  if (needs.ocr && ["tesseract", "pdf-to-img"].includes(probe.id)) return true;
  if (needs.artifacts && probe.category === "optional-artifacts") return true;
  return undefined;
}

export function capabilityTelemetrySnapshot(
  report: CapabilityProbeReport,
  needs: CapabilityPromptNeeds = {},
): CapabilityTelemetryProbe[] {
  return report.probes.map((probe) => ({
    id: probe.id,
    status: probe.status,
    category: probe.category,
    importance: probe.importance,
    workflows: probe.workflows,
    versionFamily: versionFamily(probe.version),
    affectedCurrentRun: affectedCurrentRun(probe, needs),
  }));
}
