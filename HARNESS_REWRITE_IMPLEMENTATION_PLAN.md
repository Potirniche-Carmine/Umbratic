# Aegis OpenCode Full Migration Plan

## Decision

Keep the Aegis UI, delete the Aegis daemon path, and use OpenCode as the actual harness/backend.

Aegis should become a focused desktop client for OpenCode: it launches a local `opencode serve` process, talks to it through the OpenCode SDK/HTTP/SSE APIs, keeps the Aegis visual experience, and customizes OpenCode through config, agents, instructions, and small extension points. OpenCode owns the hard backend work: sessions, prompts, tool calls, permissions, file edits, shell commands, diffs, LSP, MCP, local model providers, and future agent features.

This is a destructive backend migration, not a compatibility refactor. The old Aegis daemon did not work well enough to preserve, so the plan is to remove it first, then rebuild the backend integration around OpenCode as the single source of truth. Aegis should only customize the parts that make it feel personal, local, secure, and opinionated.

## Sources Reviewed

- OpenCode repository: https://github.com/anomalyco/opencode
- OpenCode server docs: https://opencode.ai/docs/server/
- OpenCode SDK docs: https://opencode.ai/docs/sdk/
- OpenCode config docs: https://opencode.ai/docs/config/
- OpenCode provider docs: https://opencode.ai/docs/providers/
- OpenCode tools docs: https://opencode.ai/docs/tools/
- OpenCode permissions docs: https://opencode.ai/docs/permissions/
- OpenCode share docs: https://opencode.ai/docs/share
- OpenCode troubleshooting/storage docs: https://opencode.ai/docs/troubleshooting/
- OpenCode Zen/privacy docs: https://opencode.ai/docs/zen
- Aider repository: https://github.com/Aider-AI/aider
- LangGraph repository: https://github.com/langchain-ai/langgraph
- PearAI repository: https://github.com/trypear/pearai-app

## Target Outcome

- Aegis UI stays recognizable and local-first.
- `aegis-daemon` is removed from the app, scripts, package flow, and renderer assumptions.
- Electron main launches and supervises OpenCode directly.
- Renderer uses the OpenCode SDK/client APIs instead of Aegis WebSocket JSON-RPC.
- OpenCode is restricted to one Aegis-approved local provider/model entry.
- LM Studio remains the model source, using its OpenAI-compatible local endpoint.
- The user can swap the actual loaded LM Studio model later without exposing an in-app model marketplace or provider picker.
- OpenCode sharing is disabled.
- OpenCode cloud/free-model routes are disabled.
- Aegis does not configure OpenTelemetry or third-party telemetry.
- The OpenCode child process runs with a scrubbed environment and local-only network posture wherever we can enforce it.
- Any future share/export feature is owned by Aegis, not OpenCode's public share service.

## Privacy And Data Rules

These are product requirements, not optional implementation notes.

1. Disable OpenCode sharing.
   - Set `"share": "disabled"` in the generated OpenCode config.
   - Do not expose `/share`, `/unshare`, or share-related UI in Aegis.
   - Treat any OpenCode share event/command as blocked.
   - OpenCode docs say shared conversations sync history to their servers and are publicly accessible by link, so this must stay off.

2. Do not use OpenCode Zen or free hosted models.
   - Set `enabled_providers` to only the Aegis-local provider, initially `["aegis-lmstudio"]`.
   - Set `disabled_providers` defensively for known cloud providers such as `opencode`, `openai`, `anthropic`, `google`, `gemini`, `openrouter`, `xai`, and others discovered in the resolved config.
   - Do not call `/connect` for OpenCode Zen from Aegis.
   - Do not store OpenCode cloud provider credentials.
   - OpenCode Zen docs note that some free models may collect data for improvement and that some provider-backed APIs have retention windows. Aegis local mode must avoid those paths.

3. Use LM Studio locally.
   - Configure an OpenAI-compatible provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "aegis-lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Aegis Local Model",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "local": {
          "name": "LM Studio loaded model"
        }
      }
    }
  },
  "model": "aegis-lmstudio/local",
  "small_model": "aegis-lmstudio/local",
  "enabled_providers": ["aegis-lmstudio"],
  "share": "disabled",
  "autoupdate": false
}
```

   - If OpenCode requires the configured model ID to match LM Studio's actual `/models` ID, Phase 0 must add a model ID resolver that fetches `GET /v1/models` from LM Studio and writes exactly one model into the generated config.
   - The Aegis UI should show one model row such as "Local LM Studio" and not expose provider/model switching.

4. Disable telemetry by policy and environment.
   - Do not configure any OpenCode plugin, hook, or OpenTelemetry exporter.
   - Clear `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, and related `OTEL_*` variables for the OpenCode child process unless the user explicitly opts into diagnostics later.
   - Clear `OPENCODE_AUTO_SHARE`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and provider API key env vars from the child process unless Aegis intentionally sets them.
   - Set `autoupdate: false` so the sidecar does not call update services during normal startup.
   - Keep `webfetch` and `websearch` disabled for the default local profile.
   - In the spike, verify with logs/network inspection that local-mode startup and a sample task do not contact OpenCode cloud services.

5. Keep server access local.
   - Launch `opencode serve` with `--hostname 127.0.0.1`.
   - Use a random high port.
   - Set `OPENCODE_SERVER_PASSWORD` and use Basic auth from Electron.
   - Set `server.mdns: false`.
   - Set CORS to the exact Aegis renderer origin in development and no broad wildcard in production.

6. Keep Aegis data ownership.
   - Aegis can read OpenCode session data for display, but OpenCode's public sharing should never become the Aegis sharing system.
   - If Aegis later adds sharing, it should be an Aegis-owned local export, encrypted bundle, or user-controlled destination.
   - Logs and session data remain on the user's machine unless the user explicitly exports them.

## Final Architecture

```text
Aegis Electron app
  |
  +-- main process
  |     |
  |     +-- launches opencode serve
  |     +-- generates locked local config
  |     +-- stores local auth token/password
  |     +-- enforces environment/network privacy policy
  |
  +-- renderer
        |
        +-- Aegis UI
        +-- OpenCode SDK / HTTP client
        +-- OpenCode SSE event stream
        +-- Aegis-only project picker, diff views, permission surfaces, personal UX
              |
              v
        local OpenCode server on 127.0.0.1
              |
              v
        LM Studio on 127.0.0.1:1234/v1
```

The Rust daemon is removed outright. If a future branch needs to inspect the old implementation, git history is enough.

## What Aegis Owns Vs OpenCode Owns

| Area | Owner | Notes |
| --- | --- | --- |
| Chat UI and app shell | Aegis | Keep the current frontend look and workflows. |
| Backend harness | OpenCode | Tool calls, prompts, agent loops, sessions, permissions, LSP/MCP, edits. |
| Process supervision | Aegis Electron main | Start, stop, restart, authenticate, and health-check OpenCode. |
| Model routing | Aegis config over OpenCode | Lock to one LM Studio provider/model entry. |
| Model picker | Aegis | Remove/replace with "Local LM Studio" status. |
| File/project picker | Aegis | Keep native Electron project selection. |
| Permissions UX | Aegis UI over OpenCode permission API | Use OpenCode's permission IDs and response endpoint. |
| Sharing | Aegis only | OpenCode share disabled. Future Aegis share must be user-controlled. |
| Telemetry | Disabled by Aegis policy | No OTel/exporters/plugins unless future explicit opt-in. |
| Local storage | OpenCode plus Aegis metadata | Prefer OpenCode session store; add Aegis metadata only where UI needs it. |

## Candidate Evaluation Update

| Candidate | Fit | Decision |
| --- | --- | --- |
| OpenCode | Best fit. Already a local coding-agent backend with server, SDK, sessions, events, tools, permissions, LSP, MCP, and LM Studio support. | Use as the backend of record. |
| Aider | Excellent reference for repo maps and edit strategies, but not the backend substrate for Aegis. | Borrow ideas later if OpenCode extension points allow. |
| LangGraph | Great for custom durable multi-agent graphs, but would require us to build the coding harness ourselves. | Not first pass. |
| PearAI | Editor distribution, not a harness backend. | Do not use. |

## Destructive Rebuild Strategy

### Phase 0: Remove The Broken Backend

Goal: clear out the duplicated Aegis harness before building the new one, so new code cannot accidentally route through the old daemon.

Delete or disconnect:

- Remove `aegis-daemon` from the normal development and build workflow.
- Remove `daemon:build` from the root `package.json`.
- Remove Electron main logic that finds, copies, starts, restarts, or explains errors for `aegis-app.exe`.
- Remove `getDaemonConnection()` and `restartDaemon()` from the preload API.
- Remove the renderer WebSocket JSON-RPC client and pending request map.
- Remove frontend method assumptions such as `agent.send_task`, `daemon.health`, `model.list`, `project.*`, `file.read`, `git.*`, `store.overview`, and `ide.*` as daemon RPC calls.
- Remove Aegis-specific raw JSON tool-call parsing and cleanup paths from the renderer once OpenCode streaming is wired.
- Remove daemon health/status UI copy that specifically refers to the old daemon.
- Remove Rust model client, manual prompt/tool loop, SQLite session/tool-call store, and Rust file/git/search tool code from the product path.

Replace immediately with:

- Electron main as the only local supervisor.
- OpenCode server launch state in Electron main.
- OpenCode SDK/HTTP/SSE client code in the renderer.
- Small Electron-native helpers only for things that are app-shell concerns, such as native folder picking, attachments, opening files in an IDE, and local project metadata.

Exit criteria:

- Running Aegis cannot start `aegis-daemon`.
- The root scripts no longer ask developers to build the Rust daemon.
- The renderer has no live dependency on daemon startup tokens or daemon WebSocket RPC.

### Phase 1: Spike OpenCode As The Whole Backend

Goal: prove Aegis can launch and drive OpenCode after the daemon path has been removed.

Tasks:

- Install or add `opencode-ai` and `@opencode-ai/sdk`.
- In Electron main, add the new launcher:
  - Find the OpenCode executable.
  - Generate a random server password.
  - Choose a free local port.
  - Generate `OPENCODE_CONFIG_CONTENT`.
  - Launch `opencode serve --hostname 127.0.0.1 --port <port>`.
  - Poll `/global/health`.
- In the renderer, create an experimental OpenCode client.
- Create a session.
- Send a read-only prompt.
- Send an edit prompt with permissions set to ask.
- Accept a permission request from Aegis UI and resume.
- Confirm git diff changes appear in the existing diff view.
- Confirm logs/session data stay local.
- Confirm no OpenCode share is possible.
- Confirm local mode does not call OpenCode Zen/free-model endpoints.

Exit criteria:

- Aegis UI can complete one read-only task and one approved edit through OpenCode only.
- The Aegis daemon does not exist in the running path.
- The only model traffic is to LM Studio.

### Phase 2: Build The OpenCode Connection Layer

Goal: replace Aegis WebSocket JSON-RPC with OpenCode connection state.

Changes:

- Add `getOpenCodeConnection()`.
- Add `restartOpenCode()`.
- Move OpenCode launch state into Electron main.
- Add a preload API that returns:
  - OpenCode base URL.
  - Basic auth token/password or a short-lived Aegis session token that Electron translates.
  - Current local provider/model status.
- Add health/status handling for OpenCode and LM Studio.
- Add clear startup errors when OpenCode or LM Studio are unavailable.

### Phase 3: Rebuild App Features On OpenCode APIs

Goal: make the frontend talk to OpenCode directly while preserving Aegis UX.

Rebuild current features against OpenCode:

- Health -> OpenCode `/global/health` plus an Aegis LM Studio health probe.
- Model display -> one "Local LM Studio" status row, no model picker.
- Project list -> Aegis-owned local metadata in Electron storage or a small JSON/SQLite file under Aegis app data.
- Sessions -> OpenCode session APIs, annotated by Aegis project root metadata.
- Chat send -> OpenCode session message/prompt API.
- Git/diff -> OpenCode VCS/file status APIs where available; if a helper is needed, implement it in Electron main as a small app-shell utility, not through the old daemon.
- File read/search/tree -> OpenCode file/find APIs.
- IDE open project/file -> Electron-native helpers.
- Diagnostics -> OpenCode health, LM Studio health, local storage paths, provider lockdown status.

Do not recreate daemon RPC names as a compatibility layer. Prefer OpenCode names and Aegis UI domain helpers.

### Phase 4: Model Lockdown

Goal: Aegis exposes one local model option while still working with any model the user loads into LM Studio.

Implementation:

- Add `AegisModelConfigService` in Electron main.
- Probe LM Studio:
  - `GET http://127.0.0.1:1234/v1/models`.
  - Pick the first loaded model, or a user-configured preferred model ID.
  - Generate OpenCode provider config with exactly that model ID.
- If no LM Studio model is loaded:
  - Aegis shows "Start LM Studio and load a model."
  - OpenCode does not fall back to cloud providers.
- Hide or remove frontend model dropdown.
- Remove provider selection UI.
- Store only:
  - LM Studio base URL.
  - Optional preferred local model ID.
  - Last successful model ID for diagnostics.
- Keep `enabled_providers: ["aegis-lmstudio"]`.
- Keep `small_model` pointed to the same local model so title/summarization tasks do not route elsewhere.

### Phase 5: Privacy-Locked Config Generation

Goal: make privacy defaults hard to accidentally undo.

Generated OpenCode config should include:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "autoupdate": false,
  "model": "aegis-lmstudio/<resolved-model-id>",
  "small_model": "aegis-lmstudio/<resolved-model-id>",
  "enabled_providers": ["aegis-lmstudio"],
  "disabled_providers": [
    "opencode",
    "openai",
    "anthropic",
    "google",
    "gemini",
    "openrouter",
    "xai"
  ],
  "server": {
    "hostname": "127.0.0.1",
    "mdns": false,
    "cors": []
  },
  "tools": {
    "webfetch": false,
    "websearch": false
  },
  "permission": {
    "edit": "ask",
    "bash": "ask",
    "external_directory": "ask"
  }
}
```

Electron child process environment:

- Set:
  - `OPENCODE_SERVER_PASSWORD=<random>`
  - `OPENCODE_CONFIG_CONTENT=<generated config>`
- Clear:
  - `OPENCODE_AUTO_SHARE`
  - `OPENCODE_CONFIG`
  - `OPENCODE_CONFIG_DIR`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `OTEL_EXPORTER_OTLP_ENDPOINT`
  - `OTEL_EXPORTER_OTLP_HEADERS`
  - other provider or telemetry variables discovered in testing.

Validation:

- At startup, call OpenCode config/provider endpoints and assert only `aegis-lmstudio` is enabled.
- Fail closed if cloud providers appear enabled.
- Show a privacy warning if an external provider is detected.

### Phase 6: Permissions UX

Goal: use OpenCode's permission system but keep the Aegis approval bar.

Tasks:

- Subscribe to OpenCode event stream.
- Detect permission request events.
- Convert OpenCode permission requests into the current Aegis approval bar shape.
- On accept:
  - Call OpenCode permission response endpoint with "once" by default.
  - Add optional "always for this session" later if we want it.
- On decline:
  - Respond with reject.
  - Show a concise Aegis message.
- Keep default local profile:
  - reads/search allowed.
  - edits ask.
  - bash ask.
  - external directories ask or deny.
  - web tools disabled.

### Phase 7: Session, Diff, And Project Data

Goal: use OpenCode's local session store without losing Aegis ergonomics.

Tasks:

- Store Aegis project list in Electron local storage, SQLite, or a small JSON file under Aegis app data.
- Link Aegis chat IDs to OpenCode session IDs.
- Use OpenCode messages/session APIs for chat history.
- Use OpenCode diff/session diff APIs where possible.
- Keep Aegis side-by-side diff view.
- Keep IDE open-file/project helpers in Electron main.
- Add a local-only Aegis export command for debugging:
  - project path
  - OpenCode session ID
  - Aegis UI metadata
  - no upload, no public link.

### Phase 8: Personal Aegis Customization Layer

Goal: make Aegis feel like Aegis, not a generic OpenCode skin.

Use OpenCode extension points before forking:

- Generated `AGENTS.md` or Aegis instruction file for Aegis personality and local coding preferences.
- Custom primary agent named `aegis`.
- Custom subagents later for review, planning, testing, or repo understanding.
- Custom commands for common workflows.
- Custom tools only when OpenCode's built-ins are not enough.
- MCP servers only when the user explicitly enables them.

Initial Aegis defaults:

- Local-first.
- No web tools.
- No hosted providers.
- One LM Studio model.
- Conservative permissions.
- Strong diff/review UI.
- Worktree support if OpenCode and Aegis project metadata can coordinate it cleanly.

## Test Plan

Automated:

- Config generation snapshots.
- Provider lockdown test: only `aegis-lmstudio` enabled.
- Environment scrub test: cloud API keys and `OTEL_*` vars are absent from child env.
- Share-disabled test: generated config always has `share: "disabled"`.
- Server auth test: unauthenticated calls fail.
- Event mapping test: OpenCode permission/tool/message events render correctly in Aegis.
- LM Studio resolver test with fake `/v1/models`.

Manual:

- Start Aegis with LM Studio closed: app reports local model unavailable and does not fall back to cloud.
- Start LM Studio with any loaded model: Aegis resolves and uses it as the only model.
- Run read-only prompt: no approval needed.
- Run edit prompt: Aegis approval bar appears.
- Approve edit: file changes and diff view updates.
- Decline edit: no file changes.
- Run shell command request: approval required.
- Confirm OpenCode share command is unavailable/blocked.
- Confirm no OpenCode cloud endpoints are contacted in local-only mode.
- Restart Aegis: OpenCode restarts and previous local sessions/projects remain visible.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| OpenCode requires exact LM Studio model IDs. | Resolve the loaded model from LM Studio at launch and regenerate config. |
| OpenCode tries to load providers from user/global config. | Use `OPENCODE_CONFIG_CONTENT`, `enabled_providers`, `disabled_providers`, and scrub provider env vars. Validate resolved provider list at startup. |
| OpenCode has implicit network calls beyond model traffic. | Set `autoupdate: false`, disable share/web tools, scrub env, and add a Phase 0 network audit. |
| Official telemetry controls are not a single obvious config key. | Do not configure OTel/plugins, clear telemetry env vars, and fail local privacy checks if telemetry endpoints are observed. |
| Aegis loses custom behavior by removing daemon. | Rebuild customization as OpenCode agents, commands, instructions, and small SDK-side features. Fork only when extension points fail. |
| OpenCode API changes. | Pin OpenCode version, use the SDK/OpenAPI types, and isolate OpenCode calls in one client module. |
| Existing Aegis features do not map one-to-one. | Rebuild only the useful pieces as Electron/OpenCode client features. Do not preserve broken daemon compatibility. |

## Definition Of Done

- The Aegis UI runs without starting `aegis-daemon`.
- OpenCode is launched and supervised by Electron main.
- Renderer uses OpenCode SDK/HTTP/SSE for sessions, messages, tools, permissions, and file/search operations.
- Aegis exposes only "Local LM Studio" as the model path.
- Any LM Studio-loaded model can be resolved and used.
- OpenCode sharing is disabled and inaccessible through Aegis.
- OpenCode Zen/free hosted models are not available in Aegis local mode.
- OpenCode child environment is scrubbed of telemetry and cloud provider variables.
- Local-only network behavior is verified.
- Read, edit, shell, diff, permission approval, session history, project selection, and IDE open-file workflows all work from the Aegis UI.
- The old daemon code is removed from scripts, app startup, renderer assumptions, and the normal product build.
