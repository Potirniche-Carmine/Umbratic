# AGENTS.md

## Desktop App

This project is the Electron, Vite, React, and TypeScript desktop app. Keep implementation choices consistent with nearby TypeScript and React patterns.

## Design

Design matters. Keep UI changes clean, calm, fast, and intentional. Prefer simple flows, strong spacing, stable layouts, and polished interaction states.

Avoid layout shift. Reserve space, overlay transient UI, or scroll within fixed regions instead of moving stable app areas.

Keep semantic colors consistent across related states. Do not use emoji in product UI; use clear text, lucide icons, brand assets, or purpose-built visuals.

For visual changes, verify light and dark mode. Include hover, open, closed, and loading states when those states are affected.

## Testing

Run focused checks for the changed area. Use the project’s existing scripts first:

- `npm run test:all`
- `npm run desktop:build`

Clean up any dev servers, Electron processes, preview servers, or watchers before ending the chat.
