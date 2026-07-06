---
name: Python
description: Use for Python scripts, packages, tests, virtual environments, dependency setup, and Python-based verification.
---

# Python

Use this skill when the task involves Python source, packages, tests, virtual environments, `pyproject.toml`, `requirements.txt`, `pytest`, or Python-based artifact generation.

## Runtime Contract

- Keep Python work inside the current workspace. Prefer a workspace `.venv` and do not rely on shell activation.
- Prefer `uv` when it is available. Check with `uv --version` before choosing Python setup commands.
- When `uv` exists, use `uv python install 3.12` only if a suitable Python is missing, then `uv venv .venv --python 3.12`.
- Verify with `uv run python <script.py>`, `uv run pytest`, or the direct `.venv` interpreter. Do not use bare `python`, `python3`, or `py` as verification commands.
- If dependencies are needed, install them into the workspace environment with `uv add`, `uv pip install`, or `uv run --with <package> ...`.
- If `uv` is unavailable, use an existing workspace-managed environment or create `.venv` with an available managed interpreter. State the capability gap when it affects verification.
- Stop after a small number of distinct failed runtime attempts. Report the commands and errors instead of looping indefinitely.

## Workflow

1. Inspect the project files that define the Python environment, such as `pyproject.toml`, `requirements.txt`, lockfiles, test config, and nearby README instructions.
2. Reuse the project's existing commands when they are clear and safe.
3. Make the smallest focused code or test change that answers the request.
4. Run the narrowest relevant Python check first, then broaden only when the change warrants it.
5. State exactly what was verified and any environment limitation that prevented a stronger check.
