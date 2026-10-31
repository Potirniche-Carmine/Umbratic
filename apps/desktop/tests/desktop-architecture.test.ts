import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(tsx?|js)$/.test(file) && !file.endsWith(".d.ts") ? [file] : [];
  });
}

// Inspect emitted imports: type-only dependencies cannot cause initialization
// cycles and must not force shared contracts into artificial duplicate types.
function runtimeImports(file: string): string[] {
  const emitted = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const source = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) imports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

test("desktop runtime imports are acyclic and respect renderer/main boundaries", () => {
  const files = sourceFiles(root);
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const layer = path.relative(root, file).split(path.sep)[0];
    const edges: string[] = [];
    for (const specifier of runtimeImports(file)) {
      if (layer === "renderer" || layer === "shared") {
        assert.ok(!specifier.startsWith("node:") && !nodeBuiltins.has(specifier) && !/^electron(?:\/|$)/.test(specifier), `${file} imports privileged module ${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) => known.has(candidate));
      if (!target) continue; // CSS, images and assets are not runtime modules.
      const targetLayer = path.relative(root, target).split(path.sep)[0];
      if (layer === "renderer" || layer === "shared") {
        assert.ok(targetLayer !== "main" && targetLayer !== "preload", `${file} imports ${target}`);
      }
      if (layer === "shared") assert.equal(targetLayer, "shared", `shared contract imports ${target}`);
      edges.push(target);
    }
    graph.set(file, edges);
  }
  const visited = new Set<string>();
  const active: string[] = [];
  function visit(file: string) {
    const cycleStart = active.indexOf(file);
    assert.equal(cycleStart, -1, `Runtime import cycle: ${[...active.slice(cycleStart), file].map((item) => path.relative(root, item)).join(" -> ")}`);
    if (visited.has(file)) return;
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    visited.add(file);
  }
  for (const file of files) visit(file);
});
