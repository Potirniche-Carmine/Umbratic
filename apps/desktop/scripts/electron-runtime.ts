import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function electronPackageRoot() {
  return path.dirname(require.resolve("electron"));
}

export function resolveInstalledElectron() {
  const packageRoot = electronPackageRoot();
  const pathFile = path.join(packageRoot, "path.txt");
  if (!fs.existsSync(pathFile)) {
    throw new Error(
      "Electron is installed without its runtime. Run `npm run dependencies:provision` explicitly before development or packaging.",
    );
  }

  const relativeExecutable = fs.readFileSync(pathFile, "utf8").trim();
  if (!relativeExecutable || path.isAbsolute(relativeExecutable)) {
    throw new Error("Electron path.txt contains an invalid runtime path.");
  }

  const distributionRoot = path.resolve(packageRoot, "dist");
  const executable = path.resolve(distributionRoot, relativeExecutable);
  const relativeToDistribution = path.relative(distributionRoot, executable);
  if (
    relativeToDistribution.startsWith("..")
    || path.isAbsolute(relativeToDistribution)
    || !fs.existsSync(executable)
  ) {
    throw new Error(
      "Electron runtime is missing or invalid. Run `npm run dependencies:provision` explicitly.",
    );
  }
  return executable;
}
