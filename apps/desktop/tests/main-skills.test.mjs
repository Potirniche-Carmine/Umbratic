import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const skillsPath = new URL("../src/main/skills.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function electronMock(userData) {
  return {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (buffer) => buffer.toString("utf8"),
    },
  };
}

function loadSkills(userData) {
  return loadTypeScriptModule(skillsPath, { cache: new Map(), mocks: { electron: electronMock(userData) } });
}

function seedSkillsDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skills-"));
  fs.mkdirSync(path.join(directory, "engineering-review"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "engineering-review", "SKILL.md"),
    "---\nname: Engineering Review\ndescription: Use for code review.\n---\n\n# Review\n\nCheck diffs carefully.",
    "utf8",
  );
  fs.writeFileSync(path.join(directory, "marketing.md"), "# Marketing Voice\n\nWrite launch copy.", "utf8");
  fs.mkdirSync(path.join(directory, ".hidden"), { recursive: true });
  return directory;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30 + nameBuffer.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    content.copy(local, 30 + nameBuffer.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((total, row) => total + row.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

test("listSkills reads folder and markdown skills with frontmatter and settings", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-settings-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();
  fs.writeFileSync(
    path.join(directory, "umbratic-pdf.md"),
    "---\nname: PDF Custom\ndescription: Custom PDF system guidance.\n---\n\n# PDF\n\nCustom PDF guidance.",
    "utf8",
  );

  const listing = await skills.listSkills(directory, { marketing: false });
  assert.equal(listing.directory, directory);
  const localSkills = listing.skills.filter((skill) => skill.source === "local");
  assert.deepEqual(plain(localSkills).map((skill) => skill.id), ["engineering-review", "marketing"]);
  assert.equal(localSkills[0].name, "Engineering Review");
  assert.equal(localSkills[0].description, "Use for code review.");
  assert.equal(localSkills[1].name, "marketing");
  assert.equal(localSkills[1].description, "Marketing Voice");
  assert.equal(localSkills[1].enabled, false);

  const systemSkills = listing.skills.filter((skill) => skill.source === "system");
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-markdown" && skill.name === "Markdown" && !skill.readOnly && skill.enabled), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-ocr" && skill.name === "OCR"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-git-worktree" && skill.name === "Git Worktree"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-marketing"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-sales"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-engineering"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-pdf" && skill.name === "PDF Custom" && skill.description === "Custom PDF system guidance."), true);
  const migratedPdf = path.join(directory, "system", "umbratic-pdf", "SKILL.md");
  assert.equal(fs.existsSync(migratedPdf), true);
  assert.match(fs.readFileSync(migratedPdf, "utf8"), /Custom PDF system guidance/);
  assert.equal(fs.existsSync(path.join(directory, "umbratic-pdf.md")), false);

  const disabledSystem = await skills.listSkills(directory, { "umbratic-markdown": false });
  assert.equal(disabledSystem.skills.find((skill) => skill.id === "umbratic-markdown").enabled, false);
});

test("listSkills removes obsolete skill storage and does not list reserved roots", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-cleanup-settings-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-cleanup-"));
  fs.mkdirSync(path.join(directory, ".defaults"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".defaults", "old.md"), "# Old skill storage", "utf8");
  fs.mkdirSync(path.join(directory, "system"), { recursive: true });
  fs.writeFileSync(path.join(directory, "system", "SKILL.md"), "# Reserved root", "utf8");
  fs.writeFileSync(path.join(directory, "umbratic-marketing.md"), "# Retired Marketing", "utf8");
  fs.mkdirSync(path.join(directory, "system", "umbratic-engineering"), { recursive: true });
  fs.writeFileSync(path.join(directory, "system", "umbratic-engineering", "SKILL.md"), "# Retired Engineering", "utf8");

  const listing = await skills.listSkills(directory, {});
  assert.equal(fs.existsSync(path.join(directory, ".defaults")), false);
  assert.equal(fs.existsSync(path.join(directory, "umbratic-marketing.md")), false);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-engineering")), false);
  assert.equal(listing.skills.some((skill) => skill.id === "system" && skill.source === "local"), false);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-pdf", "SKILL.md")), true);
});

test("promptSkillsForRequest includes enabled skills and explicitly requested disabled skills first", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-prompt-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  const selected = skills.promptSkillsForRequest("Please use $marketing for the launch note.", directory, {
    marketing: false,
    "engineering-review": true,
  });

  assert.deepEqual(plain(selected).map((skill) => ({ id: skill.id, enabled: skill.enabled, requested: skill.requested })), [
    { id: "marketing", enabled: false, requested: true },
    { id: "engineering-review", enabled: true, requested: false },
  ]);
  assert.equal(selected[0].fullContent, true);
  assert.equal(selected[0].reason, "explicit_request");
  assert.equal(selected[1].fullContent, false);
  assert.equal(selected[1].reason, "metadata");
});

test("promptSkillsForRequest keeps local skills compact unless metadata strongly matches", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-compact-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  const generic = skills.promptSkillsForRequest("Summarize this note.", directory, {
    marketing: true,
    "engineering-review": true,
  });
  assert.deepEqual(plain(generic.map((skill) => ({ id: skill.id, fullContent: skill.fullContent, reason: skill.reason }))), [
    { id: "engineering-review", fullContent: false, reason: "metadata" },
    { id: "marketing", fullContent: false, reason: "metadata" },
  ]);

  const matched = skills.promptSkillsForRequest("Please do an engineering review of these diffs.", directory, {
    marketing: true,
    "engineering-review": true,
  });
  assert.equal(matched.find((skill) => skill.id === "engineering-review").fullContent, true);
  assert.equal(matched.find((skill) => skill.id === "engineering-review").reason, "strong_match");
});

test("promptSkillsForRequest loads explicitly referenced skill resources for full local skills", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-resources-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-resource-dir-"));
  fs.mkdirSync(path.join(directory, "deal-review", "references"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "deal-review", "SKILL.md"),
    [
      "---",
      "name: Deal Review",
      "description: Use for deal review.",
      "---",
      "",
      "# Deal Review",
      "",
      "Follow [the checklist](references/checklist.md) before writing.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(directory, "deal-review", "references", "checklist.md"), "Check buyer, blocker, value, and next step.", "utf8");

  const selected = skills.promptSkillsForRequest("Use $deal-review for this account.", directory, { "deal-review": true });
  assert.equal(selected[0].fullContent, true);
  assert.match(selected[0].content, /Referenced skill resources/);
  assert.match(selected[0].content, /references\/checklist\.md/);
  assert.match(selected[0].content, /Check buyer, blocker, value, and next step/);
});

test("systemSkillsForProfile exposes system skill metadata and full instructions only for matched skills", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-system-skills-"));
  const skills = loadSkills(userData);

  const marketing = skills.systemSkillsForProfile("marketing", "Create a PowerPoint launch deck and PDF one-pager.");
  assert.deepEqual(plain(marketing.map((skill) => skill.id)), [
    "umbratic-markdown",
    "umbratic-ocr",
    "umbratic-pdf",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]);
  assert.deepEqual(plain(marketing.map((skill) => ({ id: skill.id, source: skill.source, fullContent: skill.fullContent, reason: skill.reason }))), [
    { id: "umbratic-markdown", source: "system", fullContent: false, reason: "metadata" },
    { id: "umbratic-ocr", source: "system", fullContent: false, reason: "metadata" },
    { id: "umbratic-pdf", source: "system", fullContent: true, reason: "strong_match" },
    { id: "umbratic-presentations", source: "system", fullContent: true, reason: "strong_match" },
    { id: "umbratic-documents", source: "system", fullContent: false, reason: "metadata" },
    { id: "umbratic-spreadsheets", source: "system", fullContent: false, reason: "metadata" },
  ]);

  const engineering = skills.systemSkillsForProfile("engineering", "Fix a failing test.");
  assert.deepEqual(plain(engineering.map((skill) => ({ id: skill.id, fullContent: skill.fullContent, reason: skill.reason }))), [
    { id: "umbratic-git-worktree", fullContent: false, reason: "metadata" },
    { id: "umbratic-markdown", fullContent: false, reason: "metadata" },
    { id: "umbratic-ocr", fullContent: false, reason: "metadata" },
  ]);
  assert.equal(engineering.some((skill) => skill.id === "umbratic-presentations"), false);
  assert.equal(engineering.some((skill) => skill.id === "umbratic-spreadsheets"), false);

  const worktree = skills.systemSkillsForProfile("engineering", "workspace mode: git worktree isolated workspace");
  assert.equal(worktree.find((skill) => skill.id === "umbratic-git-worktree").fullContent, true);
  assert.equal(worktree.find((skill) => skill.id === "umbratic-git-worktree").reason, "strong_match");

  const ocr = skills.systemSkillsForProfile("engineering", "Extract text from this screenshot.");
  assert.equal(ocr.find((skill) => skill.id === "umbratic-ocr").fullContent, true);
  assert.equal(ocr.find((skill) => skill.id === "umbratic-ocr").reason, "strong_match");

  const salesMarkdown = skills.systemSkillsForProfile("sales", "Write a Markdown table for this proposal.");
  assert.equal(salesMarkdown.some((skill) => skill.id === "umbratic-markdown"), true);
  assert.equal(salesMarkdown.some((skill) => skill.id === "umbratic-sales"), false);
  assert.equal(salesMarkdown.some((skill) => skill.id === "umbratic-git-worktree"), false);
  assert.equal(salesMarkdown.find((skill) => skill.id === "umbratic-markdown").fullContent, true);
  assert.equal(salesMarkdown.find((skill) => skill.id === "umbratic-pdf").fullContent, false);

  const explicit = skills.systemSkillsForProfile("sales", "Use $umbratic-pdf to make this.", {});
  assert.equal(explicit.find((skill) => skill.id === "umbratic-pdf").fullContent, true);
  assert.equal(explicit.find((skill) => skill.id === "umbratic-pdf").reason, "explicit_request");

  const disabled = skills.systemSkillsForProfile("sales", "Write a Markdown table.", { "umbratic-markdown": false });
  assert.equal(disabled.some((skill) => skill.id === "umbratic-markdown"), false);

  const document = skills.systemSkillsForProfile("sales", "Draft a Word document memo for this account.");
  assert.equal(document.some((skill) => skill.id === "umbratic-documents"), true);
  assert.equal(document.find((skill) => skill.id === "umbratic-documents").fullContent, true);

  const spreadsheet = skills.systemSkillsForProfile("marketing", "Create an Excel campaign forecast workbook.");
  assert.equal(spreadsheet.some((skill) => skill.id === "umbratic-spreadsheets"), true);
  assert.equal(spreadsheet.find((skill) => skill.id === "umbratic-spreadsheets").fullContent, true);
});

test("systemSkillsForProfile appends capability gates to selected system skills", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-system-skill-gates-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-system-skill-gates-dir-"));

  const selected = skills.systemSkillsForProfile(
    "marketing",
    "Create a PDF one-pager.",
    {},
    {
      "umbratic-pdf": "Runtime capability gate:\n- Poppler render/inspect is missing; do not claim PDF visual QA.",
    },
    directory,
  );

  const pdfSkill = selected.find((skill) => skill.id === "umbratic-pdf");
  assert.ok(pdfSkill);
  assert.equal(pdfSkill.fullContent, true);
  assert.match(pdfSkill.content, /Use `pdfplumber` or `pypdf` for extraction/);
  assert.match(pdfSkill.content, /Runtime capability gate/);
  assert.match(pdfSkill.content, /do not claim PDF visual QA/);
});

test("skill document editing validates ids, size, and real files", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-doc-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  assert.deepEqual(plain(await skills.getSkillDocument({ id: "../bad" }, directory)), { ok: false, message: "Invalid skill id." });
  const document = await skills.getSkillDocument({ id: "engineering-review" }, directory);
  assert.equal(document.ok, true);
  assert.match(document.skill.content, /Check diffs carefully/);

  const systemDocument = await skills.getSkillDocument({ id: "umbratic-markdown" }, directory);
  assert.equal(systemDocument.ok, true);
  assert.equal(systemDocument.skill.id, "umbratic-markdown");
  assert.equal(systemDocument.skill.readOnly, false);
  assert.equal(systemDocument.skill.source, "system");
  assert.equal(systemDocument.skill.path, path.join(directory, "system", "umbratic-markdown", "SKILL.md"));
  assert.equal(fs.existsSync(systemDocument.skill.path), true);

  const systemContent = "---\nname: Markdown Custom\ndescription: Custom markdown guidance.\n---\n\n# Changed\n\nPrefer very short tables.";
  const systemSaved = await skills.saveSkillDocument({ id: "umbratic-markdown", content: systemContent }, directory);
  assert.equal(systemSaved.ok, true);
  assert.equal(systemSaved.skill.name, "Markdown Custom");
  assert.equal(systemSaved.skill.description, "Custom markdown guidance.");
  assert.equal(systemSaved.skill.modified, true);
  assert.equal(systemSaved.skill.checksumStatus, "modified");
  assert.equal(fs.readFileSync(systemDocument.skill.path, "utf8"), systemContent);

  const selectedSystem = skills.systemSkillsForProfile("sales", "Write a Markdown table.", {}, {}, directory);
  const markdownSkill = selectedSystem.find((skill) => skill.id === "umbratic-markdown");
  assert.equal(markdownSkill.name, "Markdown Custom");
  assert.match(markdownSkill.content, /Prefer very short tables/);

  const resetSystem = await skills.resetSystemSkill({ id: "umbratic-markdown" }, directory);
  assert.equal(resetSystem.ok, true);
  assert.equal(resetSystem.skill.modified, false);
  assert.equal(resetSystem.skill.checksumStatus, "known_good");
  assert.doesNotMatch(resetSystem.skill.content, /Prefer very short tables/);

  const updatedContent = "---\nname: Engineering Review\ndescription: Updated.\n---\n\nRun tests and inspect changed files.";
  const saved = await skills.saveSkillDocument({ id: "engineering-review", content: updatedContent }, directory);
  assert.equal(saved.ok, true);
  assert.equal(saved.skill.description, "Updated.");
  assert.equal(fs.readFileSync(path.join(directory, "engineering-review", "SKILL.md"), "utf8"), updatedContent);

  const tooLarge = await skills.saveSkillDocument({ id: "engineering-review", content: "x".repeat(513 * 1024) }, directory);
  assert.deepEqual(plain(tooLarge), { ok: false, message: "Skill file is too large to save." });
});

test("createSkill creates a real SKILL.md template and rejects duplicates", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-create-settings-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-create-"));

  const created = await skills.createSkill({ name: "Personal Style Guide!" }, directory);
  assert.equal(created.ok, true);
  assert.equal(created.skill.id, "personal-style-guide");
  const skillFile = path.join(directory, "personal-style-guide", "SKILL.md");
  assert.match(fs.readFileSync(skillFile, "utf8"), /name: Personal Style Guide!/);

  const duplicate = await skills.createSkill({ name: "Personal Style Guide" }, directory);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /already exists/);

  const reservedRoot = await skills.createSkill({ name: "system" }, directory);
  assert.equal(reservedRoot.ok, false);
  assert.match(reservedRoot.message, /reserved skill/);

  const reservedSystem = await skills.createSkill({ name: "Umbratic PDF" }, directory);
  assert.equal(reservedSystem.ok, false);
  assert.match(reservedSystem.message, /reserved skill/);
});

test("importSkill imports a real folder skill with referenced resources and rejects duplicates", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-import-settings-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-import-target-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-import-source-"));
  fs.mkdirSync(path.join(source, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: Imported Deal Review\ndescription: Imported folder skill.\n---\n\nRead [reference](references/source.md).",
    "utf8",
  );
  fs.writeFileSync(path.join(source, "references", "source.md"), "Imported resource text.", "utf8");

  const imported = await skills.importSkill({ sourcePath: source }, directory);
  assert.equal(imported.ok, true);
  assert.equal(imported.skill.id, "imported-deal-review");
  assert.equal(imported.skill.checksumStatus, "known_good");
  assert.equal(imported.skill.provenance, "imported");
  assert.equal(fs.existsSync(path.join(directory, "imported-deal-review", "SKILL.md")), true);
  assert.equal(fs.readFileSync(path.join(directory, "imported-deal-review", "references", "source.md"), "utf8"), "Imported resource text.");

  fs.writeFileSync(path.join(directory, "imported-deal-review", "references", "source.md"), "Changed resource text.", "utf8");
  const modifiedListing = await skills.listSkills(directory, {});
  const modifiedSkill = modifiedListing.skills.find((skill) => skill.id === "imported-deal-review");
  assert.equal(modifiedSkill.modified, true);
  assert.equal(modifiedSkill.checksumStatus, "modified");

  const duplicate = await skills.importSkill({ sourcePath: source }, directory);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /already exists/);

  const reservedSource = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-import-reserved-source-"));
  fs.writeFileSync(
    path.join(reservedSource, "SKILL.md"),
    "---\nname: Umbratic PDF\ndescription: Reserved system skill collision.\n---\n\n# Reserved",
    "utf8",
  );
  const reserved = await skills.importSkill({ sourcePath: reservedSource }, directory);
  assert.equal(reserved.ok, false);
  assert.match(reserved.message, /reserved skill/);
});

test("importSkill imports a zip skill archive with one skill folder", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-zip-settings-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-zip-target-"));
  const zipPath = path.join(os.tmpdir(), `umbratic-skill-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  fs.writeFileSync(
    zipPath,
    storedZip({
      "zipped-skill/SKILL.md": "---\nname: Zip Skill\ndescription: Imported zip skill.\n---\n\nUse @./examples.md.",
      "zipped-skill/examples.md": "Zip resource text.",
    }),
  );
  try {
    const imported = await skills.importSkill({ sourcePath: zipPath }, directory);
    assert.equal(imported.ok, true);
    assert.equal(imported.skill.id, "zip-skill");
    assert.equal(fs.readFileSync(path.join(directory, "zip-skill", "examples.md"), "utf8"), "Zip resource text.");
    const selected = skills.promptSkillsForRequest("Use $zip-skill now.", directory, { "zip-skill": true });
    assert.match(selected[0].content, /Zip resource text/);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
});
