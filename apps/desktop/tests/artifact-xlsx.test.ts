import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = new Map();
const load = (relative) =>
  loadTypeScriptModule(new URL(`../src/main/artifacts/worker/${relative}`, import.meta.url), {
    cache,
    realm: "host",
  });

const sidecar = load("xlsx/sidecar.ts");
const engine = load("engine.ts");

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-xlsx-"));
}

test("the spreadsheet sidecar is present so these tests exercise the engine", () => {
  assert.equal(
    sidecar.sidecarAvailable(),
    true,
    "umbratic-artifacts is not built; run `cargo build --locked --release --package umbratic-artifacts`",
  );
});

const modelSpec = {
  sheets: [
    {
      name: "Assumptions",
      columns: [
        { header: "Item", width: 28 },
        { header: "Value", format: "0.0%" },
      ],
      rows: [
        ["Growth", { v: 0.05, role: "input" }],
        ["Churn", { f: "=1-B2", role: "calc" }],
      ],
      freeze: "A2",
      namedRanges: { growth: "B2" },
    },
    {
      name: "Model",
      columns: [{ header: "Period" }, { header: "Revenue" }],
      rows: [
        ["Q1", { v: 100, role: "input" }],
        ["Q2", { f: "=B2*(1+Assumptions!B2)", role: "calc" }],
        ["Total", { f: "=SUM(B2:B3)", role: "total" }],
      ],
    },
  ],
};

test("the sidecar creates, inspects, and edits a workbook through the engine", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "xlsx", "model.xlsx");

  const created = await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    out: ".umbratic/artifacts/xlsx/model.xlsx",
    spec: modelSpec,
    workspaceRoot: root,
  });
  assert.equal(created.ok, true, JSON.stringify(created.errors ?? []));
  assert.equal(created.origin, "umbratic");
  assert.equal(created.editSurface, "full");
  assert.match(created.summary, /2 sheets/);
  assert.ok(fs.existsSync(out));

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "xlsx",
    absolutePath: out,
    path: ".umbratic/artifacts/xlsx/model.xlsx",
    workspaceRoot: root,
  });
  assert.equal(inspected.ok, true);
  const sheets = inspected.outline.sheets;
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["Assumptions", "Model"],
  );
  assert.deepEqual(sheets[0].header, ["Item", "Value"]);
  assert.equal(sheets[1].formulaCount, 2);
  assert.ok(inspected.outline.definedNames.includes("growth"));

  const edited = await engine.runArtifactJob({
    action: "edit",
    format: "xlsx",
    absolutePath: out,
    absoluteOut: out,
    path: ".umbratic/artifacts/xlsx/model.xlsx",
    ops: [{ op: "setCells", sheet: "Model", cells: { B2: 250 } }],
    workspaceRoot: root,
  });
  assert.equal(edited.ok, true, JSON.stringify(edited.errors ?? []));
  assert.match(edited.summary, /1 op applied/);
});

test("a formula outside the allowlist fails at the cell and writes nothing", async () => {
  const root = workspace();
  const out = path.join(root, "bad.xlsx");
  const response = await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    spec: { sheets: [{ name: "Model", rows: [[{ f: "=INDIRECT(\"A1\")" }]] }] },
    workspaceRoot: root,
  });
  assert.equal(response.ok, false);
  assert.equal(response.errors[0].path, "sheets[0].rows[0][0].f");
  assert.match(response.errors[0].message, /allowed function list/);
  assert.equal(fs.existsSync(out), false, "a rejected build must not leave a file");
});

test("recalculation reports a division by zero the edit introduced", async () => {
  const root = workspace();
  const out = path.join(root, "model.xlsx");
  await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    spec: {
      sheets: [
        {
          name: "Model",
          columns: [{ header: "Item" }, { header: "Value" }],
          rows: [["Revenue", 100], ["Units", 4], ["Price", { f: "=B2/B3" }]],
        },
      ],
    },
    workspaceRoot: root,
  });
  const edited = await engine.runArtifactJob({
    action: "edit",
    format: "xlsx",
    absolutePath: out,
    absoluteOut: out,
    ops: [{ op: "setCells", sheet: "Model", cells: { B3: 0 } }],
    workspaceRoot: root,
  });
  assert.equal(edited.ok, true, JSON.stringify(edited.errors ?? []));
  const finding = edited.qa.find((entry) => entry.kind === "formula-error");
  assert.ok(finding, `expected a recalculation error, got ${JSON.stringify(edited.qa)}`);
  assert.match(finding.message, /#DIV\/0!/);
  assert.match(finding.fix, /IFERROR/);
});

test("an unevaluable function warns and keeps its cached value", async () => {
  const root = workspace();
  const out = path.join(root, "dates.xlsx");
  const created = await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    spec: { sheets: [{ name: "Dates", columns: [{ header: "When" }], rows: [[{ f: "=TODAY()" }]] }] },
    workspaceRoot: root,
  });
  assert.equal(created.ok, true, JSON.stringify(created.errors ?? []));
  const finding = created.qa.find((entry) => entry.kind === "not-recalculated");
  assert.ok(finding, `expected a warning, got ${JSON.stringify(created.qa)}`);
  assert.equal(finding.severity, "warning");
  assert.ok(!created.qa.some((entry) => entry.severity === "error"));
});

test("a foreign workbook is surgical and refuses the full-only ops", async () => {
  const root = workspace();
  const out = path.join(root, "foreign.xlsx");
  await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    spec: { sheets: [{ name: "Data", columns: [{ header: "A" }], rows: [[1], [2]] }] },
    workspaceRoot: root,
  });

  // Strip the origin stamp, which is exactly what a stranger's file looks like.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  zip.remove("docProps/custom.xml");
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "xlsx",
    absolutePath: out,
    workspaceRoot: root,
  });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.errors ?? []));
  assert.equal(inspected.origin, "foreign");
  assert.equal(inspected.editSurface, "surgical");

  const allowed = await engine.runArtifactJob({
    action: "edit",
    format: "xlsx",
    absolutePath: out,
    absoluteOut: out,
    ops: [{ op: "setCells", sheet: "Data", cells: { A2: 42 } }],
    workspaceRoot: root,
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.errors ?? []));

  const refused = await engine.runArtifactJob({
    action: "edit",
    format: "xlsx",
    absolutePath: out,
    absoluteOut: out,
    ops: [{ op: "deleteSheet", sheet: "Data" }],
    workspaceRoot: root,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0].message, /needs a full edit surface/);
});

test("an op that names no sheet in the workbook lists the ones that exist", async () => {
  const root = workspace();
  const out = path.join(root, "model.xlsx");
  await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    absoluteOut: out,
    spec: { sheets: [{ name: "Data", rows: [[1]] }] },
    workspaceRoot: root,
  });
  const response = await engine.runArtifactJob({
    action: "edit",
    format: "xlsx",
    absolutePath: out,
    absoluteOut: out,
    ops: [{ op: "setCells", sheet: "Nope", cells: { A1: 1 } }],
    workspaceRoot: root,
  });
  assert.equal(response.ok, false);
  assert.match(response.errors[0].message, /the workbook has Data/);
});
