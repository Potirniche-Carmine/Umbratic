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
  assert.deepEqual(plain(listing.skills).map((skill) => skill.id), ["engineering-review", "marketing"]);
  assert.equal(listing.skills[0].name, "Engineering Review");
  assert.equal(listing.skills[0].description, "Use for code review.");
  assert.equal(listing.skills[1].name, "marketing");
  assert.equal(listing.skills[1].description, "Marketing Voice");
  assert.equal(listing.skills[1].enabled, false);
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
});

test("skill document editing validates ids, size, and real files", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-skill-doc-"));
  const skills = loadSkills(userData);
  const directory = seedSkillsDirectory();

  assert.deepEqual(plain(await skills.getSkillDocument({ id: "../bad" }, directory)), { ok: false, message: "Invalid skill id." });
  const document = await skills.getSkillDocument({ id: "engineering-review" }, directory);
  assert.equal(document.ok, true);
  assert.match(document.skill.content, /Check diffs carefully/);

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
