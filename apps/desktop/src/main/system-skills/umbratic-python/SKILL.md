---
name: Python
description: Create, edit, run, test, or debug Python scripts and projects, including interpreter discovery, virtual environments, dependencies, pyproject.toml, requirements files, pytest, and Python-based artifact generation.
---

# Python

Use structured workspace tools for every requested file change or verification. Prose, code fences, and proposed commands do not create or run anything.

## Choose the Smallest Runtime

1. Inspect nearby `pyproject.toml`, lockfiles, requirements files, test config, README instructions, and an existing `.venv` when they can affect the task.
2. For a standalone standard-library script, write the file first and use an available interpreter directly. Do not create a virtual environment just to run one dependency-free file.
3. For an existing project, reuse its documented command or workspace environment. Do not replace its package manager or lockfile.
4. For new dependencies or an isolated project, check `uv --version` before using `uv`. If available, prefer a workspace `.venv` and commands such as `uv venv .venv --python 3.12`, `uv add <package>`, and `uv run pytest`.
5. If `uv` is unavailable, check a likely interpreter (`python3 --version`, then `python --version` when needed) and reuse the exact command that succeeds. Create `.venv` only when isolation or dependencies justify it.

Never rely on shell activation. Use `uv run ...`, `.venv/bin/python` (Windows: `.venv\\Scripts\\python.exe`), or the discovered interpreter explicitly.

## Workflow

1. Inspect only the environment and source files relevant to the request.
2. Make the smallest focused change.
3. Run the narrowest meaningful check, then broader project tests only when warranted.
4. Read the actual exit code and output before deciding the next action.
5. State the exact file changed and command that passed. Never claim verification from expected output.

## Examples

Standalone script with no dependencies:

```text
write bubble_sort.py -> command python3 bubble_sort.py
```

Existing project environment:

```text
command .venv/bin/python -m pytest tests/test_sort.py -q
```

Dependency needed and `uv --version` succeeded:

```text
command uv add requests -> command uv run python fetch_data.py
```

## Recover from Failures

- Use the exact error to make one materially different correction. If `uv` is not found, stop issuing `uv` commands and try interpreter discovery; do not abandon the requested file change.
- If an interpreter works but an import is missing, inspect the project dependency files before installing anything.
- Do not repeatedly recreate environments, reinstall the same package, or simulate the next tool call in a code block.
- After a small number of distinct runtime failures, preserve completed file work and report the commands and errors precisely.
