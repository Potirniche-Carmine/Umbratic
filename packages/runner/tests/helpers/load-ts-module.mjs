import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function toLocalPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  const text = String(value);
  if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(text)) return text.slice(1);
  return text;
}

function resolveSourceModule(specifier, parentFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(parentFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/i, ".ts"),
    base.replace(/\.jsx$/i, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return base;
}

export function loadTypeScriptModule(filePath, options = {}) {
  const cache = options.cache ?? new Map();
  const mocks = options.mocks ?? {};

  function load(resolvedPath) {
    const absolutePath = path.resolve(toLocalPath(resolvedPath));
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;

    const source = readFileSync(absolutePath, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: absolutePath,
    }).outputText;

    const module = { exports: {} };
    cache.set(absolutePath, module);

    const localRequire = (specifier) => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      const sourcePath = resolveSourceModule(specifier, absolutePath);
      if (sourcePath) return load(sourcePath);
      return require(specifier);
    };

    vm.runInNewContext(
      output,
      {
        AbortController,
        Buffer,
        URL,
        clearTimeout,
        console,
        crypto: globalThis.crypto,
        exports: module.exports,
        fetch,
        module,
        process,
        require: localRequire,
        setTimeout,
      },
      { filename: absolutePath },
    );
    return module.exports;
  }

  return load(filePath);
}
