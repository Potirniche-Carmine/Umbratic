---
name: Git Worktree
description: Use for engineering runs that need Git worktree isolation, branch/base awareness, review diffs, merge safety, or clear explanation of how Umbratic task worktrees operate.
---

# Git Worktree

Use this skill for engineering work where Git state, task worktrees, branch isolation, review diffs, or merge behavior affects the answer. It is especially relevant when the task is running in Umbratic's isolated worktree mode.

## System Model

Umbratic can run an engineering task in either the opened repository folder or an isolated Git worktree. In isolated mode, the desktop app records the original repository path, original branch, base commit, task branch, and task worktree path before the runner starts.

The task worktree is a normal Git working tree checked out at a dedicated branch from the recorded base commit. It is not a copy of files. It shares the same Git object database with the original repository while keeping a separate working directory and index.

Umbratic-created task branches normally use the `umbratic/<task-id>-<slug>` shape. Worktree directories are placed under the user's Umbratic worktree storage, grouped by source repository. The visible current directory for the runner is the worktree path, not the original repository path.

## Core Rules

- Treat the current working directory as authoritative. If the task says it is in a worktree, inspect and edit the worktree path.
- Do not edit the original repository path directly while working in an isolated task worktree.
- Preserve the recorded base commit as the review baseline. Review diffs should be understood as changes from that base commit to the current worktree state.
- Keep branch language precise: original branch is the user's branch, task branch is the isolated agent branch, and base commit is the commit the task branch started from.
- Do not assume uncommitted original-repo changes are present in the task worktree unless they are visible there.
- Do not run destructive Git commands such as `reset --hard`, `clean -fd`, branch deletion, or worktree removal unless the user explicitly asks and the target path has been verified.

## How Git Worktrees Behave

Important Git mechanics:

- A worktree has its own working directory and index.
- Multiple worktrees for the same repository share commits, refs, remotes, tags, and object storage.
- A branch can normally be checked out in only one worktree at a time.
- Changes in one worktree do not appear in another until committed, merged, cherry-picked, rebased, or otherwise transferred.
- Untracked files are local to the worktree directory where they exist.
- Repository-level config and hooks may be shared or discovered through the common Git directory, while per-worktree metadata lives under Git's worktree administrative area.

When in doubt, verify with non-destructive reads:

- `git status --short --branch`
- `git rev-parse --show-toplevel`
- `git rev-parse HEAD`
- `git branch --show-current`
- `git worktree list --porcelain`
- `git diff --stat <base>`
- `git diff --name-status <base>`

## Editing Workflow

Before edits:

1. Confirm the worktree root with `git rev-parse --show-toplevel` when path context is ambiguous.
2. Check `git status --short --branch`.
3. Identify the requested files and nearby project instructions.
4. Read before changing. Make focused edits in the worktree.

After edits:

1. Run targeted tests or checks for the changed area.
2. Inspect `git diff --check` when text or code changes could introduce whitespace errors.
3. Review `git diff --stat <base>` and relevant hunks before summarizing.
4. Report verification performed and any gaps.

## Review And Merge Semantics

Umbratic review is based on changed files in the task workspace:

- For worktree tasks, changed files are discovered from Git diff and untracked file state relative to the recorded base commit.
- Approval merges or applies the task result back through the desktop workflow. The runner should not bypass that workflow by merging into the user's branch on its own.
- Rejection may discard the worktree changes through the desktop workflow. Do not preemptively clean or remove the worktree unless asked.
- If the user asks for a patch, summarize the changed files and important hunks. Do not claim a merge happened unless it actually happened.

## Handling Dirty Or Diverged State

If the worktree has unexpected changes:

- Distinguish user-provided existing changes from your own changes.
- Avoid overwriting or reverting changes you did not make.
- If another process changes files while you work, re-read the affected files and adapt.
- If the task branch diverges from the original branch, explain the divergence with commit IDs or branch names rather than vague wording.
- If a merge or rebase is needed, prefer explaining the planned operation first unless the user explicitly requested that Git operation.

## Command Discipline

Prefer read-only Git commands until an operation is clearly required. Good default commands include:

- `git status --short --branch`
- `git diff -- <path>`
- `git diff --name-only <base>`
- `git log --oneline --decorate --max-count=12`
- `git show --stat --oneline <commit>`
- `git worktree list`

Commands that need extra care:

- `git checkout`, `switch`, `merge`, `rebase`, `cherry-pick`, `stash`, `commit`, `reset`, `clean`, `worktree remove`, and branch deletion.
- Before using one, confirm the current worktree root, current branch, and intended target.
- Never compose path-sensitive destructive operations from unverified strings.

## Final Response

When worktree behavior matters, name it plainly:

- Say whether the work happened in the isolated task worktree or the opened repository folder.
- Mention the task branch and changed files when useful.
- Summarize tests/checks and any Git state caveat.
- Do not expose internal scratch paths unless they help the user find the worktree or understand a requested Git operation.
