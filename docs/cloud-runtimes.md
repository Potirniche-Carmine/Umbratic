# Cloud workspaces in 0.0.3

Umbratic has two modes in the same desktop app. **Private** keeps the local-model and Veil workflows. **Cloud** uses an official provider runtime on the user's computer: tools access the chosen local workspace, while inference goes to the provider. Cloud does not route inference through Veil or an Umbratic service.

## Runtime and account setup

| Provider | Integration | Authentication | Model discovery |
| --- | --- | --- | --- |
| Codex | An installed, unmodified `codex app-server`, JSONL over stdio | Native `account/login/start` with ChatGPT; `account/read` must report `chatgpt` | Paginated `model/list`, including supported reasoning efforts |
| Claude Code | Official `@anthropic-ai/claude-agent-sdk` 0.3.303, including unmodified Claude Code 2.1.303 | Native `claude auth login`; both SDK account metadata and native `auth status --json` must confirm subscription use | SDK `supportedModels()`, resolving aliases to canonical IDs |

Settings → General holds the Private/Cloud mode, appearance, provider connection, and main model. The composer also selects provider, model, and effort. Settings → Experts holds the role presets. Settings → Context holds reset preferences. Settings save immediately. Tool activity is visible by default; its only visibility control is in General settings.

Existing Codex installations are detected automatically. If missing, Install Codex downloads and runs the unmodified [official native installer](https://learn.chatgpt.com/docs/codex/cli). Claude uses the SDK's bundled executable by default; if neither it nor a local executable is available, Install Claude Code uses [Anthropic's native installer](https://code.claude.com/docs/en/setup). The explicit Install action uses no sudo, accepts no renderer-supplied URL or command, follows only verified vendor redirect destinations, bounds downloads and execution time, and removes temporary scripts. Installations are serialized and block new Cloud work. Installer exit errors remain visible. The app does not install or update a working provider in the background. General → Advanced can select an absolute executable path when automatic discovery is insufficient. An optional external Claude executable must support the SDK methods used here.

Connect Codex and Connect Claude Code open the provider's own sign-in flow. Umbratic checks the connection automatically while sign-in is pending, and refreshes the available models when connected. Browser sign-in never locks the workspace: Cancel stops the pending native login, switching providers cancels the abandoned attempt, and late replies cannot overwrite the new connection. The composer keeps its connection action in the existing controls row so account state does not insert a banner or move the input. Umbratic neither reads credential files nor stores, exchanges, or intermediates OAuth tokens. It stores only native session IDs and display account metadata for continuity checks. A changed account requires a fresh context.

Cloud does not supply API keys or alternate API endpoints, and rejects an API/gateway account before sending the instruction. It does not silently fall back to another model or billing route. Claude Fable is omitted because its usage has separate billing; fast mode is disabled. Provider plan limits and any extra usage enabled in the provider account still apply. Model discovery is not proof of entitlement or remaining quota; provider errors remain visible.

The bundled Claude binary retains all of its native authentication methods. Umbratic's subscription workflow does not modify the binary or implement a replacement Claude.ai login. Anthropic's terms govern use and distribution of that runtime. The package's original license notice is retained alongside the executable. See [Anthropic's product-hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).

## Model and workflow controls

The composer selects the main orchestrator and its effort. Settings exposes role presets without exposing the entire system prompt:

| Role | Codex default | Claude default |
| --- | --- | --- |
| Routine coding | GPT-6.1 Sol, medium | Opus 5.5, medium |
| Difficult implementation | GPT-6.1 Sol, extra high | Opus 5.5, extra high |
| Research and extraction | GPT-6.1 Terra, high | Sonnet 5.5, medium |

The refresh control retrieves the runtime catalog again. Unavailable saved models remain visible and block starting work until corrected; Umbratic never invents a live catalog. Effort choices use the runtime's reported capabilities. No context-window size is forced to one million tokens: the provider manages its effective window, and native usage metadata is retained when supplied.

The Experts switch enables or disables delegation. There is no separate reviewer preset or automatic reviewer instruction. Codex receives role/model/effort guidance for its native spawning tools. Claude receives named native agent definitions with the selected models and efforts. Research agents have a read/research tool set. The runtime owns delegation, tool execution, and result collection; these controls do not create cross-provider agents. Task selection and proportional testing are workflow guidance, not a new scheduling engine.

## Context and local state

Each provider and canonical workspace directory has a separate native session. With no folder selected, tools work in an app-owned personal workspace. Local Cloud state uses separate SQLite keys from Private chats and their runner summaries.

The runtime owns its transcript, compaction, tool loop, and native permissions. Umbratic displays output, activity, tool approvals and user questions, and sends one-use approval replies back to that runtime. Unsupported native permission requests fail closed. Stop cancels the active run and denies outstanding approvals.

Clear context drops the active native session ID and resets its counters. It keeps files and up to 500 recent display entries. It does not delete the provider's own transcript files. Previous display entries and summaries are never replayed into the new session. By default the next instruction starts fresh after three hours of inactivity or five main-session compactions. Inactivity is measured from the last runtime activity or completed/cancelled turn, persists across restarts, and is unaffected by midnight. The break can be set from 1 to 24 hours or Never; the compaction limit from 1 to 20 or Never. Active work and pending approvals are not reset. Older daily-reset settings migrate to three hours, while a disabled daily reset stays disabled. Files and recent activity remain visible.

## Privacy and packaging

Umbratic adds no analytics or automatic diagnostic uploads. Codex analytics/OTel and Claude nonessential traffic/OTel are disabled in the child configuration. Native automatic memory is disabled; automatic skill injection is omitted. Claude filesystem settings are excluded, while managed runtime policies remain authoritative. Native project instructions and runtime-specific customization can differ from the standalone interactive clients.

The Electron renderer cannot spawn these runtimes or read their credentials. Typed IPC passes through the existing trusted-sender registry; the main process controls executables, workspace selection, and active sessions. No shell is used to interpolate executable paths or prompts.

Claude platform packages are pinned by the npm lockfile's integrity hashes and reviewed individually in the supply-chain policy. They are unpacked from Electron's archive so the original executable can run. Package verification checks its version and vendor license notice. Codex remains an externally installed runtime rather than an additional bundled copy.

## Verification and current limits

Automated tests cover settings validation, model availability, inactivity reset boundaries and old-settings migration, API credential isolation, subscription detection, streamed message replacement, parent-only compaction counting, native-session isolation, approval binding, cancellation, and JSONL transport failures. IPC and startup tests cover the added mode selector.

Read-only checks on November 2, 2026 verified the Codex app-server handshake, a temporary thread with workspace-write sandbox and on-request approvals, and both model catalogs. The SDK bundled Claude 2.1.303 and reported Opus/Sonnet 5.5. A model catalog or cached subscription label is insufficient for sign-in: native authentication is checked separately before inference.

A live Codex subscription smoke test with GPT-6.1 Terra successfully used a native tool to read a disposable marker file and returned its contents through the adapter. Sol returned a provider capacity error in the same test; there was no automatic fallback. Claude's native authentication was not active, so live Claude inference remains a manual sign-in verification step.

Cloud currently reviews Git workspace changes against the existing workspace baseline. Cloud does not yet provide Private-mode worktree isolation, selective undo, document preview, attachments, dictation, or cross-provider subagents. Those features must be integrated deliberately rather than borrowing Private task IDs or replaying its history. The settings and UI preview use deterministic fixtures; they never send inference requests.

Primary references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript), [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Context research and design decisions, November 2, 2026

Recent Reddit discussions found using an October 26–November 2 search window disagree about frequent compaction versus explicit handoffs. [One self-reported usage analysis](https://www.reddit.com/r/ClaudeCode/comments/1xf3ve6/68_of_my_claude_code_spend_was_a_toofull_context/) attributes much of its usage to large context and subagents, while [another discussion](https://www.reddit.com/r/ClaudeCode/comments/1xgxsis/when_to_use_compact_when_to_use_clear/) emphasizes that clearing loses the working state. A [Codex report dated October 26](https://www.reddit.com/r/codex/comments/1xfldeq/long_codex_chat_stuck_compacting_context_repeated/) describes compaction trouble in a long, image-heavy chat. These are anecdotes, sometimes promoting tools, not controlled comparisons or a consensus. Relative timestamps on retrieved pages were inconsistent with search dates. The X search did not produce a verifiable recent sample.

The implementation follows the official guidance: keep work scoped, bound file reads and tool results, delegate only useful independent work, and reuse concise findings. [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices) recommend focused outcomes and native compaction. [Claude Code's context guidance](https://code.claude.com/docs/en/context-window) distinguishes compaction from clearing and describes research agents as a way to keep large reads out of the parent context.

Five compactions is retained as the user's configurable freshness preference, not a proven optimum. The three-hour break is likewise a product preference, not a cache expiration estimate. Both can be disabled. No fixed token window is forced and no speculative summary, handoff, or memory is automatically replayed after reset.

Caching remains native. [Claude's caching documentation](https://code.claude.com/docs/en/prompt-caching) describes distinct main-session and subagent caches, and notes that changing models or prompt structure can affect reuse. Umbratic keeps its workflow instructions deterministic, resumes the native session during an active stretch of work, and avoids extra background model requests. [OpenAI's API caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents matching-prefix reuse; its API retention controls and prices are not assumed to describe Codex subscription billing. No keepalive prompts, proxy cache, custom TTL overrides, or promised subscription savings are added.

The UI uses app-styled popover listboxes in the top layer, with checkmarks, keyboard navigation, type-ahead, and outside-click dismissal, the system font, reduced-motion and reduced-transparency fallbacks, and a single Settings entry. Private's mode switch is in General settings as well. This is an Electron/web approximation of Apple materials, not a native SwiftUI Liquid Glass implementation.

## Live verification, November 2, 2026

The installed Codex runtime returned eight non-hidden models through paginated `model/list`: GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna. The menus retain the provider's labels and effort capabilities. A native GPT-6.1 Terra medium turn successfully read a temporary marker file through a tool using the existing ChatGPT subscription connection. No API key was supplied. This verifies the tested account and runtime, not universal model entitlement.

The browser design preview uses a sanitized snapshot of that model response. It still performs no authentication or inference; the desktop app queries the runtime. Provider marks are unmodified vendor assets with provenance in `src/renderer/cloud/assets/README.md`.

The final desktop UI check selected GPT-6.1 Terra from the live catalog and submitted a read-only instruction through the composer. The native tool read `check.txt` in an isolated test workspace, the expected text appeared, tool activity was visible by default, and the app returned to idle. Browser interaction checks covered keyboard model selection, both appearances, both mode switches, the install/connect preview flow, cancellation of an unfinished login, and unchanged composer coordinates across connection states. Regression tests cover late login replies, provider switches during inspection, cancel/retry, and stored activity preferences. `npm run test:all` passed, including 780 desktop tests; the unsigned local package and `verify:package` also passed. Claude inference was not exercised because no Claude subscription session was connected.
