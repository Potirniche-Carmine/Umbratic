---
name: Skill Creator
description: Create, revise, structure, and validate reusable Umbratic personal skills and their bundled resources. Use whenever the user asks to make a new skill, turn a workflow into a skill, improve an existing SKILL.md, refine skill triggering, organize skill references or scripts, or prepare a skill folder for import into Umbratic.
---

# Skill Creator

Help the user turn repeatable work into a compact, dependable Umbratic skill. Adapt the depth of the process to the request: a small guidance skill may need only a focused `SKILL.md`, while a fragile workflow may benefit from reusable scripts, references, examples, and explicit validation.

## Umbratic Skill Model

Umbratic exposes enabled skills to the model as an index containing each skill's id, name, description, and source. When a skill is relevant, the harness makes its instructions available through `read_skill`; the full body is not injected into every task.

Personal skills live under `~/.umbratic/skills/<skill-id>/SKILL.md`. Bundled system skills live under `~/.umbratic/skills/system/<skill-id>/SKILL.md`, are reserved by Umbratic, and can be edited or reset in Skills settings. Create user-requested skills as personal skills; do not place them in the `system` directory or reuse an `umbratic-*` system id.

The runner normally writes only inside the current task workspace. Unless the user gives an accessible destination, build a complete importable skill folder in the workspace and tell the user to import it from Umbratic's Skills settings. Do not claim an installed skill was changed unless that write actually succeeded.

## Core Principles

- Keep the always-visible description precise because it determines when the skill is considered.
- Keep `SKILL.md` concise because its complete contents must be read before the skill is applied.
- Include only guidance the model would not reliably infer on its own.
- Explain intent and decision criteria instead of accumulating rigid rules without rationale.
- Match specificity to risk: allow judgment for flexible work and use deterministic scripts or exact steps for fragile operations.
- Keep behavior unsurprising. Do not hide unrelated actions, credential collection, data transfer, or instructions that conflict with the user's stated goal.

## Skill Anatomy

Create only the files the skill needs:

```text
skill-id/
├── SKILL.md
├── scripts/       # optional deterministic or repeated operations
├── references/    # optional detailed knowledge loaded when needed
└── assets/        # optional templates or files copied into outputs
```

Do not add a README, changelog, installation guide, or process diary unless the user's requested skill genuinely uses it as an output asset. Keep detailed content in `references/` and link to each relevant file directly from `SKILL.md`; avoid deep chains of references.

## Creation Workflow

### 1. Capture intent

Use the conversation and supplied artifacts before asking questions. Establish:

1. What the skill should enable Umbratic to do.
2. Which user requests or contexts should trigger it.
3. What inputs, outputs, tools, and dependencies it expects.
4. What successful behavior looks like, including important edge cases.

Ask only for missing information that would materially change the design. For a well-specified request, proceed with reasonable assumptions and state them.

### 2. Choose the skill id and destination

- Normalize the id to lowercase letters, digits, and hyphens.
- Prefer a short, action-oriented id and keep the folder name identical to it.
- Do not use the reserved `system` id or an existing bundled system-skill id.
- Preserve the existing id and folder name when revising a skill unless the user explicitly requests a rename.
- Default to an importable folder in the current workspace when direct access to the personal skills directory is unavailable.

### 3. Plan reusable contents

For each representative use case, consider how the work would be done from scratch. Add a bundled resource only when it removes repeated work or makes execution more reliable:

- Put deterministic, reusable operations in `scripts/` and test them directly.
- Put schemas, policies, long examples, or domain knowledge in `references/`.
- Put templates, fonts, icons, and boilerplate copied into deliverables in `assets/`.

Do not duplicate the same instructions in `SKILL.md` and a reference file.

### 4. Write `SKILL.md`

Use YAML frontmatter with exactly `name` and `description`:

```markdown
---
name: Human-readable name
description: State what the skill does and the concrete situations in which Umbratic should use it.
---

# Human-readable name

Write concise, imperative guidance here.
```

Write all trigger guidance in `description`; the body is loaded only after the skill is selected. Make the description broad enough to cover realistic phrasing but narrow enough to avoid adjacent tasks that do not need the skill.

In the body:

- Use direct, imperative instructions.
- Put the main workflow first.
- State decision points, required checks, and expected outputs.
- Include short examples when they clarify a non-obvious format or boundary.
- Link optional resources with explicit guidance about when to read them.
- Keep the file comfortably below 500 lines; split detailed material before it becomes difficult to scan.

### 5. Validate

Inspect the finished folder and verify:

- The folder id uses lowercase letters, digits, and hyphens and matches the intended skill id.
- `SKILL.md` exists, is readable text, and starts with valid `---` frontmatter.
- Frontmatter contains non-empty `name` and `description` fields and no unrelated metadata.
- The description states both capability and triggering context.
- Every referenced relative file exists inside the skill folder.
- Scripts run successfully on at least one representative input and avoid host-specific assumptions unless documented.
- No secrets, generated caches, build output, absolute machine paths, or unrelated files are included.
- The instructions use Umbratic terminology and do not assume unavailable products, commands, agents, viewers, or marketplaces.

Run any repository-provided validator when one exists. Otherwise perform these checks directly and report what was verified.

### 6. Test and iterate

For a behaviorally significant skill, propose two or three realistic prompts covering the main path and an edge case. Exercise the draft in fresh Umbratic tasks when the user wants evaluation or when failures would be costly. Judge whether it triggers appropriately, follows the intended workflow, uses resources correctly, and produces the expected result.

Revise general instructions rather than overfitting to one test. Remove guidance that causes wasted work, explain the reason behind important constraints, and bundle helpers when the same implementation is repeatedly recreated.

## Revising an Existing Skill

Read the complete `SKILL.md` and any resource directly relevant to the requested change before editing. Preserve the skill's id, intent, and useful user customizations. Keep changes focused, update broken resource links, and verify that the description still matches the body. If the installed path is not writable from the task, create a revised importable copy in the workspace instead of pretending the installed version was updated.

## Handoff

Tell the user:

- The skill id and the exact folder or `SKILL.md` path created or changed.
- Which reusable resources were included and why.
- What validation or representative testing was completed.
- Any dependency or execution gap that remains.
- When the result is a workspace draft, that it can be imported and enabled from Umbratic's Skills settings.

For a modified bundled system skill, mention that Skills settings can reset it to the packaged version.
