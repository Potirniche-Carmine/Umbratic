import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
import { systemSkillEnabledFlags } from "../src/shared/harnessSkills.ts";

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

test("installBundledSystemSkills provisions the central skills layout", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-install-settings-"));
  const skills = loadSkills(userData);
  const directory = path.join(userData, "skills");

  assert.equal(skills.skillsDirectoryPath(), directory);
  assert.equal(skills.installBundledSystemSkills(directory), path.resolve(directory));
  const creatorSkillPath = path.join(directory, "system", "umbratic-skill-creator", "SKILL.md");
  assert.equal(fs.existsSync(creatorSkillPath), true);
  const creatorSkill = fs.readFileSync(creatorSkillPath, "utf8");
  assert.match(creatorSkill, /Umbratic Skill Model/);
  assert.doesNotMatch(creatorSkill, /Claude|Cowork/i);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-markdown", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-spreadsheets", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-data-analysis", "SKILL.md")), true);
  const documentsSkill = fs.readFileSync(path.join(directory, "system", "umbratic-documents", "SKILL.md"), "utf8");
  // The visual-QA section is gone with the render path it depended on: the
  // checks are deterministic now and come back in the tool's own qa[].
  assert.match(documentsSkill, /`artifact` tool/);
  assert.doesNotMatch(documentsSkill, /In-App Review Snapshot|\.docx\.review\.json|Visual QA/);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-cmake", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-discovery", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-product-spec", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-security-review", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-marketing-brief", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-sales-enablement", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-competitive-research", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-news-briefing", "SKILL.md")), true);
  // OCR stays orphaned on disk: umbratic-pdf covers that path in v1.
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-ocr")), false);
  assert.match(fs.readFileSync(path.join(directory, "system", "umbratic-pdf", "SKILL.md"), "utf8"), /## OCR/);
  const pythonSkill = fs.readFileSync(path.join(directory, "system", "umbratic-python", "SKILL.md"), "utf8");
  assert.match(pythonSkill, /write the file first/i);
  assert.match(pythonSkill, /If `uv` is not found, stop issuing `uv` commands/i);
  assert.match(pythonSkill, /Prose, code fences, and proposed commands do not create or run anything/i);
  const competitiveSkill = fs.readFileSync(path.join(directory, "system", "umbratic-competitive-research", "SKILL.md"), "utf8");
  assert.match(competitiveSkill, /web_search/);
  assert.match(competitiveSkill, /web_fetch/);
  // One copy of these skills ships to both deployments, and which engine answers
  // a search belongs to the deployment: Veil's own when the server runs it, the
  // runner's direct search when it does not. Naming one would be wrong half the
  // time, so the copy describes the results rather than the engine — the same
  // reason Veil's public-web prompt and the runner's tool description name none.
  // Engine hosts still appear as a web_fetch deny-list, which is not that claim.
  assert.match(competitiveSkill, /Umbratic search returns results from the public web/);
  assert.doesNotMatch(competitiveSkill, /search is (?:Brave|DuckDuckGo)/i);
  assert.match(competitiveSkill, /Never invent a domain/);
  const newsSkill = fs.readFileSync(path.join(directory, "system", "umbratic-news-briefing", "SKILL.md"), "utf8");
  assert.match(newsSkill, /web_search/);
  assert.match(newsSkill, /Reuters/);
  assert.match(newsSkill, /training data/);
  assert.match(newsSkill, /Umbratic search returns results from the public web/);
  assert.doesNotMatch(newsSkill, /search is (?:Brave|DuckDuckGo)/i);
  assert.match(newsSkill, /Never invent a company domain/);
});

test("skill frontmatter accepts inline and list path globs", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-frontmatter-"));
  const skills = loadSkills(userData);
  assert.deepEqual(plain(skills.parseSkillFrontmatter(`---
name: Rust
paths: [packages/runner/**, "**/*.rs"]
---`)).paths, ["packages/runner/**", "**/*.rs"]);
  assert.deepEqual(plain(skills.parseSkillFrontmatter(`---
name: Desktop
paths:
  - apps/desktop/**
  - '**/*.tsx'
---`)).paths, ["apps/desktop/**", "**/*.tsx"]);
});

test("system skill installation includes schemas, upgrades untouched resources, and preserves edits", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-resources-"));
  try {
    const skills = loadSkills(userData);
    const directory = path.join(userData, "skills");
    skills.installBundledSystemSkills(directory);
    for (const id of ["documents", "presentations", "spreadsheets", "pdf"]) {
      for (const name of ["spec.md", "ops.md"]) {
        const resource = path.join(directory, "system", `umbratic-${id}`, "references", name);
        assert.ok(fs.readFileSync(resource, "utf8").length > 100, resource);
      }
    }
    const resource = path.join(directory, "system", "umbratic-documents", "references", "spec.md");
    const bundled = fs.readFileSync(resource, "utf8");
    fs.writeFileSync(resource, "old installed schema");
    const manifestPath = path.join(directory, ".manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.systemSkills["umbratic-documents/references/spec.md"].installedChecksum =
      `sha256:${crypto.createHash("sha256").update("old installed schema").digest("hex")}`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    skills.installBundledSystemSkills(directory);
    assert.equal(fs.readFileSync(resource, "utf8"), bundled);
    fs.writeFileSync(resource, "my custom schema");
    skills.installBundledSystemSkills(directory);
    assert.equal(fs.readFileSync(resource, "utf8"), "my custom schema");
    fs.unlinkSync(resource);
    skills.installBundledSystemSkills(directory);
    assert.equal(fs.readFileSync(resource, "utf8"), bundled);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("system resource installation does not follow destination symlinks", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-resource-link-"));
  try {
    const skills = loadSkills(userData);
    const directory = path.join(userData, "skills");
    const root = path.join(directory, "system", "umbratic-documents");
    const outside = path.join(userData, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "references"), process.platform === "win32" ? "junction" : "dir");
    skills.installBundledSystemSkills(directory);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

function storedZip(entries, options = {}) {
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
    central.writeUInt32LE(options.externalAttrs?.[name] ?? 0, 38);
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
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-skill-creator" && skill.name === "Skill Creator" && skill.enabled), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-markdown" && skill.name === "Markdown" && !skill.readOnly && skill.enabled), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-ocr"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-git-worktree" && skill.name === "Git Worktree"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-python" && skill.name === "Python"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-cmake" && skill.name === "C/CMake"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-discovery" && skill.name === "Discovery"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-product-spec" && skill.name === "Product Spec"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-security-review" && skill.name === "Security Review"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-marketing-brief" && skill.name === "Marketing Brief"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-sales-enablement" && skill.name === "Sales Enablement"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-competitive-research" && skill.name === "Competitive Research"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-news-briefing" && skill.name === "News Briefing"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-data-analysis" && skill.name === "Data Analysis"), true);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-marketing"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-sales"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-engineering"), false);
  assert.equal(systemSkills.some((skill) => skill.id === "umbratic-pdf" && skill.name === "PDF & OCR"), true);
  assert.equal(systemSkills.find((skill) => skill.id === "umbratic-spreadsheets")?.enabled, false);
  assert.equal(systemSkills.find((skill) => skill.id === "umbratic-git-worktree")?.enabled, true);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-pdf", "SKILL.md")), true);

  const disabledSystem = await skills.listSkills(directory, { "umbratic-markdown": false });
  assert.equal(disabledSystem.skills.find((skill) => skill.id === "umbratic-markdown").enabled, false);
});

test("system skills follow the current harness unless the user overrides them", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-harness-skills-"));
  const skills = loadSkills(userData);
  const storage = loadTypeScriptModule(new URL("../src/main/storage.ts", import.meta.url), {
    cache: new Map(),
    mocks: { electron: electronMock(userData) },
  });
  const directory = seedSkillsDirectory();
  const enabled = (listing, id) => listing.skills.find((skill) => skill.id === id)?.enabled;

  const engineering = await skills.listSkills(directory, {});
  assert.equal(enabled(engineering, "umbratic-git-worktree"), true);
  assert.equal(enabled(engineering, "umbratic-cmake"), true);
  assert.equal(enabled(engineering, "umbratic-spreadsheets"), false);
  assert.equal(enabled(engineering, "umbratic-presentations"), false);
  assert.equal(enabled(engineering, "umbratic-marketing-brief"), false);
  assert.equal(enabled(engineering, "umbratic-competitive-research"), false);
  assert.equal(enabled(engineering, "umbratic-news-briefing"), false);

  storage.writeHarnessProfileSetting("marketing");
  const marketing = await skills.listSkills(directory, {});
  assert.equal(enabled(marketing, "umbratic-marketing-brief"), true);
  assert.equal(enabled(marketing, "umbratic-competitive-research"), true);
  assert.equal(enabled(marketing, "umbratic-news-briefing"), true);
  assert.equal(enabled(marketing, "umbratic-spreadsheets"), true);
  assert.equal(enabled(marketing, "umbratic-presentations"), true);
  assert.equal(enabled(marketing, "umbratic-git-worktree"), false);
  assert.equal(enabled(marketing, "umbratic-cmake"), false);
  assert.equal(enabled(marketing, "umbratic-sales-enablement"), false);

  storage.writeHarnessProfileSetting("sales");
  const sales = await skills.listSkills(directory, {});
  assert.equal(enabled(sales, "umbratic-sales-enablement"), true);
  assert.equal(enabled(sales, "umbratic-competitive-research"), true);
  assert.equal(enabled(sales, "umbratic-news-briefing"), true);
  assert.equal(enabled(sales, "umbratic-marketing-brief"), false);
  assert.equal(enabled(sales, "umbratic-spreadsheets"), true);
  assert.equal(enabled(sales, "umbratic-git-worktree"), false);

  const reenabled = await skills.listSkills(directory, { "umbratic-cmake": true });
  assert.equal(enabled(reenabled, "umbratic-cmake"), true);
  assert.equal(enabled(reenabled, "umbratic-git-worktree"), false);

  storage.writeSkillSettings({ "umbratic-spreadsheets": true });
  assert.equal(enabled(await skills.listSkills(directory), "umbratic-spreadsheets"), true);
  storage.writeSkillSettings(systemSkillEnabledFlags("engineering"));
  assert.equal(enabled(await skills.listSkills(directory), "umbratic-spreadsheets"), false);
  assert.equal(enabled(await skills.listSkills(directory), "umbratic-git-worktree"), true);
});

test("listSkills does not list the reserved system root", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-reserved-settings-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-reserved-"));
  fs.mkdirSync(path.join(directory, "system"), { recursive: true });
  fs.writeFileSync(path.join(directory, "system", "SKILL.md"), "# Reserved root", "utf8");

  const listing = await skills.listSkills(directory, {});
  assert.equal(listing.skills.some((skill) => skill.id === "system" && skill.source === "local"), false);
  assert.equal(fs.existsSync(path.join(directory, "system", "umbratic-pdf", "SKILL.md")), true);
});

test("enabledPromptSkills returns every enabled skill as metadata with a readable instruction path", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-enabled-skill-catalog-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  const catalog = skills.enabledPromptSkills(directory, {
    marketing: false,
    "engineering-review": true,
    "umbratic-python": false,
  });

  assert.equal(catalog.some((skill) => skill.id === "marketing"), false);
  assert.equal(catalog.some((skill) => skill.id === "umbratic-python"), false);
  assert.equal(catalog.some((skill) => skill.id === "engineering-review"), true);
  assert.equal(catalog.some((skill) => skill.id === "umbratic-skill-creator"), true);
  assert.equal(catalog.some((skill) => skill.id === "umbratic-cmake"), true);
  assert.equal(catalog.some((skill) => skill.id === "umbratic-presentations"), false);
  assert.equal(catalog.every((skill) => !("fullContent" in skill) && !("content" in skill) && !("reason" in skill)), true);
  assert.equal(catalog.every((skill) => fs.existsSync(skill.instructionPath)), true);
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

  const selectedSystem = skills.enabledPromptSkills(directory, {});
  const markdownSkill = selectedSystem.find((skill) => skill.id === "umbratic-markdown");
  assert.equal(markdownSkill.name, "Markdown Custom");
  assert.equal(fs.readFileSync(markdownSkill.instructionPath, "utf8"), systemContent);

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
    const selected = skills.enabledPromptSkills(directory, { "zip-skill": true });
    assert.equal(selected.find((skill) => skill.id === "zip-skill").instructionPath, path.join(directory, "zip-skill", "SKILL.md"));
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
});

test("importSkill rejects zip archives with too many entries or symlink entries", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-zip-limits-"));
  const skills = loadSkills(userData);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-zip-limits-target-"));
  const crowded = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`entry-${index}.md`, `# ${index}`]),
  );
  const crowdedPath = path.join(os.tmpdir(), `umbratic-skill-crowded-${Date.now()}.zip`);
  const symlinkPath = path.join(os.tmpdir(), `umbratic-skill-symlink-${Date.now()}.zip`);
  fs.writeFileSync(crowdedPath, storedZip(crowded));
  fs.writeFileSync(
    symlinkPath,
    storedZip(
      {
        "symlink-skill/SKILL.md": "---\nname: Symlink Skill\ndescription: Bad.\n---\n\nBody.",
        "symlink-skill/link.md": "target",
      },
      { externalAttrs: { "symlink-skill/link.md": (0o120000 << 16) >>> 0 } },
    ),
  );
  try {
    const tooMany = await skills.importSkill({ sourcePath: crowdedPath }, directory);
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.message, /too many zip entries/i);
    const symlink = await skills.importSkill({ sourcePath: symlinkPath }, directory);
    assert.equal(symlink.ok, false);
    assert.match(symlink.message, /symlink/i);
  } finally {
    fs.rmSync(crowdedPath, { force: true });
    fs.rmSync(symlinkPath, { force: true });
  }
});

test("SkillInfo lives in the shared IPC contract, not a second main or renderer copy", () => {
  const skillsSource = fs.readFileSync(new URL("../src/main/skills.ts", import.meta.url), "utf8");
  const shared = fs.readFileSync(new URL("../src/shared/desktopApiTypes.ts", import.meta.url), "utf8");
  const rendererTypes = fs.readFileSync(new URL("../src/renderer/rendererTypes.ts", import.meta.url), "utf8");
  const mainTypes = fs.readFileSync(new URL("../src/main/types.ts", import.meta.url), "utf8");
  assert.match(shared, /export type SkillInfo =/);
  assert.match(shared, /source: "system" \| "local"/);
  assert.match(shared, /paths\?: string\[\]/);
  assert.doesNotMatch(skillsSource, /export type SkillInfo/);
  assert.doesNotMatch(rendererTypes, /export type SkillInfo/);
  assert.doesNotMatch(mainTypes, /export type SkillInfo =/);
});
