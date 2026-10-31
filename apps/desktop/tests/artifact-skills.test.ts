import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(desktopRoot, "src", "main", "system-skills");

/** The four skills the artifact tool serves. */
const artifactSkills = [
  "umbratic-presentations",
  "umbratic-documents",
  "umbratic-spreadsheets",
  "umbratic-pdf",
];

test("artifact skills link to readable schemas and document the visible default output", () => {
  const formats = ["pptx", "docx", "xlsx", "pdf"];
  artifactSkills.forEach((skill, index) => {
    const root = path.join(skillsRoot, skill);
    const body = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
    assert.ok(body.includes(`Files land in \`artifacts/${formats[index]}/\``), skill);
    for (const resource of ["references/spec.md", "references/ops.md"]) {
      assert.ok(fs.readFileSync(path.join(root, resource), "utf8").trim(), `${skill}/${resource}`);
    }
    for (const match of body.matchAll(/`(references\/[\w./-]+\.md)`/g)) {
      assert.ok(fs.statSync(path.join(root, match[1])).isFile(), `${skill}/${match[1]}`);
    }
  });
});

test("the spreadsheet reference examples create and edit a workbook while preserving formulas", () => {
  const root = path.join(skillsRoot, "umbratic-spreadsheets", "references");
  const example = (name: string) => JSON.parse(
    fs.readFileSync(path.join(root, name), "utf8").match(/```json\r?\n([\s\S]*?)\r?\n```/)![1],
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-schema-"));
  const output = path.join(directory, "budget.xlsx");
  const binary = path.resolve(desktopRoot, "../../target/release", process.platform === "win32" ? "umbratic-artifacts.exe" : "umbratic-artifacts");
  const run = (job: object) => JSON.parse(execFileSync(binary, [], { input: JSON.stringify(job), encoding: "utf8" }));
  try {
    const created = run({ action: "create", format: "xlsx", spec: example("spec.md"), absoluteOut: output, out: "budget.xlsx" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const edited = run({ action: "edit", format: "xlsx", ops: example("ops.md"), absolutePath: output, absoluteOut: output, path: "budget.xlsx", out: "budget.xlsx" });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const inspected = run({ action: "inspect", format: "xlsx", absolutePath: output, path: "budget.xlsx" });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.deepEqual(inspected.outline.sheets[0].sample[0], ["Hosting", "150"]);
    assert.equal(inspected.outline.sheets[0].formulas.B4, "SUM(B2:B3)");
    assert.equal(edited.qa.filter((finding: { severity: string }) => finding.severity === "error").length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the Documents skill teaches a valid create spec with a table and callout", () => {
  const body = fs.readFileSync(path.join(skillsRoot, "umbratic-documents", "SKILL.md"), "utf8");
  const create = JSON.parse(body.match(/```json\r?\n([\s\S]*?)\r?\n```/)![1]);
  const { readDocumentSpec } = loadTypeScriptModule(new URL("../src/main/artifacts/worker/blocks/spec.ts", import.meta.url));
  const parsed = readDocumentSpec(create.spec, "docx");
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.ok(parsed.spec.blocks.some((block) => block.type === "table"));
  assert.ok(parsed.spec.blocks.some((block) => block.type === "callout"));
});

test("each artifact skill has frontmatter and stays inside its size budget", () => {
  for (const skill of artifactSkills) {
    const file = path.join(skillsRoot, skill, "SKILL.md");
    const body = fs.readFileSync(file, "utf8");
    // A skill body is in context whenever the skill is enabled, so its size is
    // a running cost rather than a one-off.
    assert.ok(
      Buffer.byteLength(body) <= 6 * 1024,
      `${skill}/SKILL.md is ${Buffer.byteLength(body)} bytes; the budget is 6144`,
    );
    // Tolerant of CRLF: .gitattributes checks these out LF, but a clone made
    // before it existed still holds CRLF, and a skill is no less valid for the
    // line endings its working copy happens to carry.
    const frontmatter = /^---\r?\nname: (.+?)\r?\ndescription: (.+?)\r?\n---\r?\n/.exec(body);
    assert.ok(frontmatter, `${skill}/SKILL.md needs name and description frontmatter`);
    // The description is the routing signal: it has to name the file types and
    // the verbs, or the skill never gets selected for the request it serves.
    assert.ok(
      frontmatter[2].length > 60,
      `${skill} description is too thin to route on: ${frontmatter[2]}`,
    );
  }
});

test("the artifact skills route through the tool rather than through library code", () => {
  for (const skill of artifactSkills) {
    const body = fs.readFileSync(path.join(skillsRoot, skill, "SKILL.md"), "utf8");
    assert.match(body, /`artifact` tool/, `${skill} should name the tool`);
    // The path this replaced: skills that told the model to call a library when
    // the host happened to have one.
    for (const banned of ["pptxgenjs", "python-pptx", "openpyxl", "reportlab", "LibreOffice", "soffice"]) {
      const mention = new RegExp(`\\b${banned}\\b`, "i");
      if (!mention.test(body)) continue;
      assert.match(
        body,
        new RegExp(`(Never write|never shell out to|no other library)[^.]*${banned}`, "i"),
        `${skill} mentions ${banned} outside a prohibition`,
      );
    }
  }
});

test("the orphaned OCR skill is gone and its guidance lives in the PDF skill", () => {
  assert.equal(fs.existsSync(path.join(skillsRoot, "umbratic-ocr")), false);
  const pdf = fs.readFileSync(path.join(skillsRoot, "umbratic-pdf", "SKILL.md"), "utf8");
  assert.match(pdf, /## OCR/);
  assert.match(pdf, /\.ocr\.json/);
  assert.match(pdf, /[Pp]reserve uncertainty/);
});

test("the generated references are in step with the limits the code enforces", () => {
  const generated = ["umbratic-presentations", "umbratic-documents", "umbratic-pdf"].flatMap((skill) =>
    ["spec.md", "ops.md"].map((name) => path.join(skillsRoot, skill, "references", name)),
  );
  // What is being asked is whether the text is in step with the code, not which
  // line endings the working copy carries. The generator writes LF; a clone
  // made before .gitattributes holds CRLF, and comparing the two raw reports
  // every file stale while the words are identical.
  const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const before = generated.map(read);
  execFileSync("node", ["scripts/generate-skill-references.ts"], {
    cwd: desktopRoot,
    stdio: "pipe",
  });
  generated.forEach((file, index) => {
    assert.equal(
      read(file),
      before[index],
      `${path.relative(desktopRoot, file)} is stale; run npm run generate:skill-references`,
    );
  });
});

test("the spreadsheet skill lists exactly the formula allowlist the engine enforces", () => {
  const body = fs.readFileSync(path.join(skillsRoot, "umbratic-spreadsheets", "SKILL.md"), "utf8");
  const source = fs.readFileSync(
    path.join(desktopRoot, "..", "..", "packages", "artifacts", "src", "formula.rs"),
    "utf8",
  );
  const declared = [...source.matchAll(/^\s{4}"([A-Z0-9]+)",$/gm)].map((match) => match[1]);
  assert.ok(declared.length > 40, `expected the allowlist, found ${declared.length} entries`);
  for (const name of declared) {
    assert.match(body, new RegExp(`\\b${name}\\b`), `${name} is missing from the skill`);
  }
});
