import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRoots = ["apps", "packages", "infrastructure", "scripts"];
const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".js",
  ".jsx",
  ".rs",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  ".git",
  // Third-party source the packaging build clones. Gitignoring it is not
  // enough: this walks the filesystem, not the index.
  ".llama-cache",
  ".package",
  "dist",
  "dist-electron",
  "node_modules",
  "release",
  "target",
  "vendor",
]);
const lineLimit = 1_000;
// One remaining exception. The other oversized files were split into real
// modules; this one is still a single React `App` component. Removing it means
// decomposing `App` into child components with render tests to prove the
// decomposition is behavior-preserving — a change that deserves its own review.
// The limit is pinned to the file's exact current size, so it can only shrink.
const grandfatheredLimits = new Map<string, number>([
  ["apps/desktop/src/renderer/main.tsx", 4_930],
]);

function sourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...sourceFiles(absolute));
      }
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolute);
    }
  }
  return files;
}

function lineCount(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf8");
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

const failures: string[] = [];
const grandfathered: string[] = [];
for (const root of sourceRoots) {
  for (const filePath of sourceFiles(path.join(repositoryRoot, root))) {
    const relative = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
    const lines = lineCount(filePath);
    if (lines <= lineLimit) continue;
    const previousLimit = grandfatheredLimits.get(relative);
    if (previousLimit === undefined) {
      failures.push(`${relative}: ${lines} lines (new file over ${lineLimit})`);
    } else if (lines > previousLimit) {
      failures.push(`${relative}: ${lines} lines (baseline ${previousLimit})`);
    } else {
      grandfathered.push(`${relative}: ${lines} lines`);
    }
  }
}

if (failures.length > 0) {
  console.error("Source file size budget failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Source file size budget passed. ${grandfathered.length} existing oversized files did not grow.`,
  );
}
