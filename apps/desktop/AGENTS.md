# AGENTS.md

## Desktop App

This project is the Electron, Vite, React, and TypeScript desktop app. Keep implementation choices consistent with nearby TypeScript and React patterns.

Keep the desktop harness thin, simple, and direct. Its responsibilities are product UI, local workspace context, attachments, permissions, safe tool execution, review flows, event streaming, and transport to a purpose-built Veil route. Prefer straightforward request and state flows over client-side orchestration frameworks.

## Veil Boundary

Veil owns model-facing behavior. Do not add system prompts, hidden behavioral prompts, personas, skill-selection prompts, route-specific guidance, model policy, model selection, or provider/runtime decision logic to the Electron app, renderer, desktop harness, or local runner.

This rule applies in both modes: Local mode must go through the app-managed local Veil process, and Server mode must go through the hosted Veil service. Do not bypass Veil to call Ollama, vLLM, or another model runtime directly.

The desktop may select the explicit product route requested by the user, such as engineering, marketing, or sales. Veil owns the prompt and model behavior behind that route. Per-request model selection and protected model configuration belong in Veil.

Client-to-model content must be limited to the user's content and factual local context such as workspace facts, repository instruction files, attachments, conversation history, capability results, and tool results. Keep context envelopes neutral; do not use them to shape personality, restrict general capabilities, select skills, or prescribe response style. If new model guidance seems necessary, implement it in `infrastructure/veil/internal/prompts` or another appropriate Veil policy layer instead of the harness.

Enabled skills are an index, not pre-injected instructions. The desktop may send validated skill id, name, description, and source metadata and make the local `read_skill` capability available. Veil must instruct the model when and how to read a relevant skill. Never preselect skills with desktop heuristics or inject full skill bodies from the harness.

The runner must reject client system-prompt overrides. Keep provider credentials, protected prompts, route policy, and model details out of renderer-visible state and user-facing diagnostics.

## Design

Design and UI/UX quality are first-order product requirements, not final-pass polish. Hold every user-facing change to the quality bar expected from an Apple design engineer or an Airbnb product design team: clear hierarchy, restrained visual language, excellent typography and spacing, obvious interaction affordances, thoughtful defaults, and meticulous state design.

Keep the experience clean, calm, fast, and intentional. Prefer simple flows, strong spacing, stable layouts, progressive disclosure, and polished interaction states. The interface should make complex model and workspace infrastructure feel simple without exposing internal implementation concepts unnecessarily.

Before adding a control, setting, label, modal, or status surface, confirm that it is necessary and that the same outcome cannot be expressed more simply. Avoid configuration-heavy UI, developer-centric terminology, duplicated controls, and screens that expose Veil or runner internals instead of the user's task.

Avoid layout shift. Reserve space, overlay transient UI, or scroll within fixed regions instead of moving stable app areas.

Keep semantic colors consistent across related states. Do not use emoji in product UI; use clear text, lucide icons, brand assets, or purpose-built visuals.

For visual changes, verify light and dark mode. Include hover, focus, pressed, disabled, open, closed, empty, loading, success, and error states whenever they are relevant. Check keyboard navigation, accessible names, contrast, responsive sizing, truncation, overflow, and reduced-motion behavior.

Review visual work in the running app at realistic window sizes. Do not consider a UI change complete based only on typechecks, snapshots, or static source review.

## Testing

Run focused checks for the changed area. Use the project’s existing scripts first:

- `npm run test:all`
- `npm run desktop:build`

Clean up any dev servers, Electron processes, preview servers, or watchers before ending the chat.
