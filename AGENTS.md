# AGENTS.md

## Project Overview

Umbratic is a desktop AI app built with Electron, Vite, React, and TypeScript. The workspace is organized as an npm workspace with the main desktop app in `desktop/` and the local runner package in `desktop/runner/`.

## Product And Design Bar

Design and UX should stay at the forefront of every change. Interfaces should feel clean, fluid, intentional, and fast: the kind of polish engineers and designers at Apple, Airbnb, or Tesla would be proud to ship.

Prefer simple, elegant flows over busy surfaces. Preserve visual clarity, smooth interactions, responsive layouts, strong spacing, and details that make the app feel calm and premium. Avoid changes that technically work but make the experience feel clunky, crowded, slow, or visually inconsistent.

Avoid layout shift as a core design requirement. Interactive changes such as attaching files, opening composer affordances, streaming state updates, or revealing transient controls should not move stable app regions or cause the rest of the UI to jump; reserve space, overlay transient content, or scroll within fixed regions instead.

Do not use emoji in product UI. Prefer clear text, lucide icons, brand assets, custom illustration, or purpose-built visual treatments instead of emoji shortcuts.

## Technology

This project primarily uses TypeScript across the Electron main process, preload layer, React renderer, and local runner. The frontend uses React with Vite, and the desktop shell uses Electron.

When adding or changing code, follow the existing TypeScript patterns and local project structure. Keep implementation choices consistent with nearby files before introducing new abstractions or dependencies.

## Context Gathering

Gather only the context needed for the task at hand. Read the nearest relevant files, package metadata, tests, and call sites before editing, but avoid broad, unrelated repo sweeps unless the change clearly crosses boundaries.

Use focused searches and inspect existing patterns before making assumptions. Keep edits scoped to the requested behavior and the files that naturally own it.

## Testing And Local Servers

When running tests, dev servers, preview servers, Electron processes, or any other long-lived command, always clean them up before ending the chat. Do not leave local servers, watch processes, or background app sessions running after verification is complete.

If a server or app process was started to test something, stop it and confirm it is closed before reporting back to the user.
