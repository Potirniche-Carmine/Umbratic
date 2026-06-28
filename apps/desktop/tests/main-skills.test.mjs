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

  const harnessSkills = listing.skills.filter((skill) => skill.source === "harness");
  assert.equal(harnessSkills.some((skill) => skill.id === "harness-markdown" && skill.readOnly && skill.enabled), true);

  const disabledHarness = await skills.listSkills(directory, { "harness-markdown": false });
  assert.equal(disabledHarness.skills.find((skill) => skill.id === "harness-markdown").enabled, false);
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

test("harnessSkillsForProfile selects mode-specific artifact skills", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-harness-skills-"));
  const skills = loadSkills(userData);

  const marketing = skills.harnessSkillsForProfile("marketing", "Create a PowerPoint launch deck and PDF one-pager.");
  assert.deepEqual(plain(marketing.map((skill) => skill.id)), [
    "harness-pdf-artifacts",
    "harness-presentation-artifacts",
    "harness-marketing-content",
  ]);
  assert.equal(marketing.every((skill) => skill.fullContent && skill.reason === "harness_mode"), true);

  const engineering = skills.harnessSkillsForProfile("engineering", "Fix a failing test.");
  assert.deepEqual(plain(engineering.map((skill) => skill.id)), ["harness-engineering-workspace"]);

  const salesMarkdown = skills.harnessSkillsForProfile("sales", "Write a Markdown table for this proposal.");
  assert.equal(salesMarkdown.some((skill) => skill.id === "harness-markdown"), true);
  assert.equal(salesMarkdown.some((skill) => skill.id === "harness-sales-enablement"), true);

  const disabled = skills.harnessSkillsForProfile("sales", "Write a Markdown table.", { "harness-markdown": false });
  assert.equal(disabled.some((skill) => skill.id === "harness-markdown"), false);

  const document = skills.harnessSkillsForProfile("sales", "Draft a Word document memo for this account.");
  assert.equal(document.some((skill) => skill.id === "harness-document-artifacts"), true);

  const spreadsheet = skills.harnessSkillsForProfile("marketing", "Create an Excel campaign forecast workbook.");
  assert.equal(spreadsheet.some((skill) => skill.id === "harness-spreadsheet-artifacts"), true);
});

test("skill document editing validates ids, size, and real files", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-doc-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  assert.deepEqual(plain(await skills.getSkillDocument({ id: "../bad" }, directory)), { ok: false, message: "Invalid skill id." });
  const document = await skills.getSkillDocument({ id: "engineering-review" }, directory);
  assert.equal(document.ok, true);
  assert.match(document.skill.content, /Check diffs carefully/);

  const harnessDocument = await skills.getSkillDocument({ id: "harness-markdown" }, directory);
  assert.equal(harnessDocument.ok, true);
  assert.equal(harnessDocument.skill.readOnly, true);
  assert.equal(harnessDocument.skill.source, "harness");
  assert.match(harnessDocument.skill.path, /^harness:\/\//);

  const harnessSaved = await skills.saveSkillDocument({ id: "harness-markdown", content: "# Changed" }, directory);
  assert.deepEqual(plain(harnessSaved), { ok: false, message: "Built-in harness skills are read-only." });

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
});
