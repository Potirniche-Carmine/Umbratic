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
  // Vite's `?url` import yields the asset's URL as a string rather than its
  // contents. Under test there is no bundler to emit the asset, and no caller
  // fetches it, so the specifier itself stands in for the URL.
  if (specifier.endsWith("?url")) return "__asset_url__";
  if (/\.(css|scss|sass|less)$/i.test(specifier)) return "__style__";
  const base = path.resolve(path.dirname(parentFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/i, ".ts"),
    base.replace(/\.jsx$/i, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
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
  const globals = options.globals ?? {};

  function load(resolvedPath) {
    if (resolvedPath === "__style__") return {};
    if (resolvedPath === "__asset_url__") return { default: "asset:test" };
    const absolutePath = path.resolve(toLocalPath(resolvedPath));
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;

    const source = readFileSync(absolutePath, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
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

    // Modules that hand values to a native or heavily-validating dependency
    // have to run in this realm. A new context has its own Array and Object
    // intrinsics, so an array literal built inside it fails an `instanceof
    // Array` check in a library loaded out here — which is a property of the
    // test harness, not of the code under test. Running in the host realm the
    // way Node's own CommonJS loader does removes the boundary entirely.
    if (options.realm === "host") {
      const wrapper = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname, globalsBag) {`
          + `with (globalsBag) { ${output}\n}`
          + `})`,
        { filename: absolutePath },
      );
      wrapper(
        module.exports,
        localRequire,
        module,
        absolutePath,
        path.dirname(absolutePath),
        globals,
      );
      return module.exports;
    }

    vm.runInNewContext(
      output,
      {
        AbortController,
        Buffer,
        Headers,
        TextDecoder,
        TextEncoder,
        URL,
        URLSearchParams,
        __dirname: path.dirname(absolutePath),
        __filename: absolutePath,
        clearInterval,
        clearTimeout,
        console,
        crypto: globalThis.crypto,
        exports: module.exports,
        fetch,
        module,
        process,
        require: localRequire,
        setInterval,
        setTimeout,
        structuredClone,
        ...globals,
      },
      { filename: absolutePath },
    );
    return module.exports;
  }

  return load(filePath);
}

