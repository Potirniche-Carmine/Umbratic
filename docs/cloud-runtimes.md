# Cloud workspaces in 0.0.3

Umbratic has one workspace interface with **ChatGPT**, **Claude**, and **Local & Veil** in the sidebar. Each has its own conversations and execution backend. Subscription providers use official runtimes on the user's computer: tools access the chosen local workspace, while inference goes to the provider. Subscription inference does not route through Veil or an Umbratic service.

The shared shell brings the cloud interface's glass materials, composer, navigation, and settings to the existing local workbench. Local chats retain their runner, indexing, worktrees, review, and model workflows. Projects are shared; conversation transcripts, native session IDs, and unsent drafts are kept separate. Switching providers leaves active work mounted and shows its activity beside the provider name. The cloud runtime still accepts one active run at a time; another provider's composer explains when it is busy.

## Runtime and account setup

| Provider | Integration | Authentication | Model discovery |
| --- | --- | --- | --- |
| Codex | An installed, unmodified `codex app-server`, JSONL over stdio | Native `account/login/start` with ChatGPT; `account/read` must report `chatgpt` | Paginated `model/list`, including supported reasoning efforts |
| Claude Code | Official `@anthropic-ai/claude-agent-sdk` 0.3.303, including unmodified Claude Code 2.1.303 | Native `claude auth login`; both SDK account metadata and native `auth status --json` must confirm subscription use | SDK `supportedModels()`, resolving aliases to canonical IDs |

One Settings panel is available from every provider. General holds appearance; Providers holds subscription accounts, Experts, and Context; Local & Veil holds the existing local/gateway connection controls. Voice and Keyboard are shared pages. Provider selection lives in the sidebar, while model and effort stay in the composer. Settings save immediately. Tool activity remains visible and individually expandable.

Existing Codex installations are detected automatically. If missing, Install Codex downloads and runs the unmodified [official native installer](https://learn.chatgpt.com/docs/codex/cli). Claude uses the SDK's bundled executable by default; if neither it nor a local executable is available, Install Claude Code uses [Anthropic's native installer](https://code.claude.com/docs/en/setup). The explicit Install action uses no sudo, accepts no renderer-supplied URL or command, follows only verified vendor redirect destinations, bounds downloads and execution time, and removes temporary scripts. Installations are serialized and block new Cloud work. Installer exit errors remain visible. The app does not install or update a working provider in the background. An optional configured external Claude executable must support the SDK methods used here.

Connect Codex and Connect Claude Code open the provider's own sign-in flow. Umbratic checks the connection automatically while sign-in is pending, and refreshes the available models when connected. Browser sign-in never locks the workspace: Cancel stops the pending native login, and each provider's controller keeps its own connection state. The composer keeps its connection action in the existing controls row so account state does not insert a banner or move the input. Umbratic neither reads credential files nor stores, exchanges, or intermediates OAuth tokens. It stores only native session IDs and display account metadata for continuity checks. A changed account requires a fresh context.

Cloud does not supply API keys or alternate API endpoints, and rejects an API/gateway account before sending the instruction. It does not silently fall back to another model or billing route. Models reported by Claude Code, including Fable 5.1, are selectable. The runtime enforces account access; fast mode is disabled. Fable may use included allowance or usage credits depending on the provider plan and seat, as described in [Claude’s model configuration](https://code.claude.com/docs/en/model-config#fable-and-usage-credits). Umbratic does not buy credits or switch to API-key authentication. Provider plan limits and any extra usage enabled in the provider account still apply. Model discovery is not proof of entitlement or remaining quota; provider errors remain visible.

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

Every conversation has its own stable identity within a provider and canonical set of workspace directories. Multiple chats can use the same project without sharing a native session. Folder order does not change session identity. Only registered, user-selected folders are passed as Codex writable roots or Claude additional directories. Adding or removing folders opens a separate chat. With no folder selected, tools work in an app-owned personal workspace. Subscription chat state uses separate SQLite keys from local chats and their runner summaries. The sidebar groups chats by project and supports search, creation, and deletion. Initial blank chats also have an identity so an unsent draft remains reachable after creating another chat.

The runtime owns its transcript, compaction, tool loop, and native permissions. Umbratic displays output, activity, tool approvals and user questions, and sends one-use approval replies back to that runtime. Unsupported native permission requests fail closed. Stop cancels the active run and denies outstanding approvals.

Manual Clear context requires confirmation and removes the current chat's saved transcript, unused attachment copies, session reference, and counters. Workspace files and other chats stay. It does not delete provider-managed transcript files. By default the next instruction renews the native session after three hours of inactivity while retaining saved messages and attachments in the archive. A persisted context boundary prevents older messages from being replayed into that fresh session. Inactivity is measured from the last runtime activity or completed/cancelled turn, persists across restarts, and is unaffected by midnight. The break can be set from 1 to 24 hours or Never; there is no compaction-count reset. Active work and pending approvals are not reset. Older daily-reset settings migrate to three hours, while a disabled daily reset stays disabled. Old compaction-count preferences are discarded.

## Privacy and packaging

Umbratic adds no analytics or automatic diagnostic uploads. Codex analytics/OTel and Claude nonessential traffic/OTel are disabled in the child configuration. Native automatic memory is disabled; automatic skill injection is omitted. Claude filesystem settings are excluded, while managed runtime policies remain authoritative. Native project instructions and runtime-specific customization can differ from the standalone interactive clients.

The Electron renderer cannot spawn these runtimes or read their credentials. Typed IPC passes through the existing trusted-sender registry; the main process controls executables, workspace selection, and active sessions. No shell is used to interpolate executable paths or prompts.

Claude platform packages are pinned by the npm lockfile's integrity hashes and reviewed individually in the supply-chain policy. They are unpacked from Electron's archive so the original executable can run. Package verification checks its version and vendor license notice. Codex remains an externally installed runtime rather than an additional bundled copy.

## Verification and current limits

Automated tests cover settings validation, model availability, inactivity renewal boundaries and old-settings migration, API credential isolation, subscription detection, streamed message replacement, parent-only compaction counting, native-session isolation, approval binding, cancellation, and JSONL transport failures. Archive tests cover separate provider histories, multiple chats in one workspace, migration, exact-chat deletion, attachment references, draft preservation, and stale asynchronous selections. IPC and startup tests cover the unified workspace entry point.

Read-only checks on November 2, 2026 verified the Codex app-server handshake, a temporary thread with workspace-write sandbox and on-request approvals, and both model catalogs. The SDK bundled Claude 2.1.303 and reported Opus/Sonnet 5.5. A model catalog or cached subscription label is insufficient for sign-in: native authentication is checked separately before inference.

A live Codex subscription smoke test with GPT-6.1 Terra successfully used a native tool to read a disposable marker file and returned its contents through the adapter. Sol returned a provider capacity error in the same test; there was no automatic fallback. At the initial checkpoint Claude was not signed in; the subsequent verification below exercised the connected Claude subscription.

Subscription chats review Git workspace changes against the existing workspace baseline and support file previews, attachments, local dictation, and review comments. Local worktree isolation and selective undo remain part of Local & Veil; provider runtimes retain their native tool and permission behavior. No cross-provider subagents or history replay are introduced. The settings and UI preview use deterministic fixtures; they never send inference requests.

Primary references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript), [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Context research and design decisions, November 2, 2026

Recent Reddit discussions found using an October 26–November 2 search window disagree about frequent compaction versus explicit handoffs. A self-reported usage analysis from October 25 was excluded from the past-week sample; [another discussion](https://www.reddit.com/r/ClaudeCode/comments/1xgxsis/when_to_use_compact_when_to_use_clear/) emphasizes that clearing loses the working state. The [October 27 Codex subagent discussion](https://www.reddit.com/r/codex/comments/1xgn9am/did_i_get_the_sub_agents_idea_correctly/) describes bounded delegation and warns that extra agents consume allowance faster. These reports support keeping delegation selective, but do not establish an optimal reset cadence. These are anecdotes, sometimes promoting tools, not controlled comparisons or a consensus. Relative timestamps on retrieved pages were inconsistent with search dates. The X search did not produce a verifiable recent sample.

The implementation follows the official guidance: keep work scoped, bound file reads and tool results, delegate only useful independent work, and reuse concise findings. [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices) recommend focused outcomes and native compaction. [Claude Code's context guidance](https://code.claude.com/docs/en/context-window) distinguishes compaction from clearing and describes research agents as a way to keep large reads out of the parent context.

There is no evidence for a universal five-compaction threshold. Compaction-count reset has been removed completely, including the setting and migration of old values. Native compaction continues normally. The three-hour break remains a configurable product preference, not a cache-expiration estimate, and can be disabled. No fixed token window is forced and no speculative summary, handoff, or memory is automatically replayed after reset.

Caching remains native. [Claude's caching documentation](https://code.claude.com/docs/en/prompt-caching) describes distinct main-session and subagent caches, and notes that changing models or prompt structure can affect reuse. Umbratic keeps its workflow instructions deterministic, resumes the native session during an active stretch of work, and avoids extra background model requests. [OpenAI's API caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents matching-prefix reuse; its API retention controls and prices are not assumed to describe Codex subscription billing. No keepalive prompts, proxy cache, custom TTL overrides, or promised subscription savings are added.

The UI uses app-styled popover listboxes in the top layer, with checkmarks, keyboard navigation, type-ahead, and outside-click dismissal, the system font, reduced-motion and reduced-transparency fallbacks, and a single Settings entry. Provider navigation is always available in the sidebar. This is an Electron/web approximation of Apple materials, not a native SwiftUI Liquid Glass implementation.

## Live verification, November 2, 2026

The installed Codex runtime returned eight non-hidden models through paginated `model/list`: GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna. The menus retain the provider's labels and effort capabilities. A native GPT-6.1 Terra medium turn successfully read a temporary marker file through a tool using the existing ChatGPT subscription connection. No API key was supplied. This verifies the tested account and runtime, not universal model entitlement.

The browser design preview uses a sanitized snapshot of that model response. It still performs no authentication or inference; the desktop app queries the runtime. Provider marks are unmodified vendor assets with provenance in `src/renderer/cloud/assets/README.md`.

The final desktop UI check selected GPT-6.1 Terra from the live catalog and submitted a read-only instruction through the composer. The native tool read `check.txt` in an isolated test workspace, the expected text appeared, tool activity was visible by default, and the app returned to idle. Browser interaction checks covered keyboard model selection, both appearances, both mode switches, the install/connect preview flow, cancellation of an unfinished login, and unchanged composer coordinates across connection states. Regression tests cover late login replies, provider switches during inspection, cancel/retry, and stored activity preferences. `npm run test:all` passed, including 780 desktop tests; the unsigned local package and `verify:package` also passed. At that initial checkpoint Claude inference was not exercised; subsequent verification is recorded below.

## Composer and runtime refinements

Cloud and Private now share `PromptTextarea`, Enter/list-continuation logic, pasted-file reading, image previews, `WorkingBlock`, `ReviewPanel`, and the feedback chip/dialog. Plain Enter follows the existing keyboard preference; Shift+Enter continues numbered, bullet, and task lists. IME composition does not submit. The input grows to 340 pixels or 40% of the viewport. Feedback is a removable attachment with readable file/line comments; it is serialized only when submitted, not dumped as JSON into the input.

Cloud accepts pasted, dropped, or selected images. Main-process validation limits batches to eight images and 20 MB per image, decodes and normalizes them to PNG, stores them in the app-owned image directory, and only resolves opaque image IDs at submission. Codex receives native `localImage` items; Claude receives native image content blocks. Existing Private chat IDs are not reused.

Tool rows are updated by native tool ID as they start and finish. The shared activity component groups progress and exposes command details on demand. Review opens immediately with loading state and caches the last diff per root; opening it does not lock the composer. One topbar button owns review visibility, and the folder icon owns a multi-selection folder menu. Settings and its full-width close control sit at bottom left.

Codex quota comes from `account/rateLimits/read` and update notifications. Claude quota uses the pinned SDK's structured usage reader and the documented `/usage` assistant `usage_report`. Both reads have a bounded timeout. The parser accepts current server meter rows and older control-response windows, including model-specific allowance. Recent successful readings are retained per provider/account for up to 15 minutes through transient empty replies, and expired windows are excluded. No credentials are extracted and no provider web endpoint is scraped. This Claude API is explicitly unstable, so an SDK update must reverify it. Remaining allowance is derived from the provider's 0–100 used percentage, with each window's reset time. Unknown usage is never represented as zero. The UI refreshes on connection checks and turns, without displaying a last-updated timestamp.

Codex context comes from native token-usage notifications. Claude context uses `getContextUsage({ detail: "summary" })`, which estimates from the last response and local state without per-category token-count calls. The provider reports the window size; Umbratic does not force a million-token setting. Canonical resolved Claude model IDs supply versioned labels such as Opus 5.5; supported efforts remain provider-supplied.

### Subsequent live checks

Both Codex (GPT-6.1 Terra, medium) and Claude Code (Opus 5.5, medium) completed a read-only native tool turn in an isolated test workspace. Both also correctly identified a synthetic blue image sent through their native image input. The Claude usage reader initially returned no usable windows, then supplied real five-hour and weekly windows after the next turn; the UI handled both states. Claude reported an estimated 26,339-token context and a 1,000,000-token raw window in that session, without an app override.

The native multi-selection folder picker added a disposable App/Notes workspace, and both providers successfully read files from both selected roots. Review opened immediately on its synthetic Git diff. A line comment became a removable feedback chip and opened the shared dialog without putting JSON in the prompt. Browser checks verified image paste, Shift+Enter list continuation, plain Enter submission, a 288-pixel expanded input at a 720-pixel viewport, and no blue textarea focus outline. Manual reset restored the empty canvas. The compaction-count reset was then removed entirely at the user's request.

Final verification passed `npm run test:all` with 788 desktop tests, the desktop production build, and unsigned macOS package verification. Tool details preserve native command/output text independently of their compact activity label. No release tag, merge to main, or public release was created.

### UI and usage follow-up

Usage and context use color-coded radial meters. Server-provided Claude severity and headline selection are preserved; other readings use usage-pressure thresholds. Unknown readings are shown as a dash. The context heading omits “estimated”; the underlying Claude value is still its native context summary, not an independently measured count.

Local Markdown file links open an in-app text preview. The main process resolves real paths against all selected workspace roots, rejects outside paths and symlink escapes, and caps previews at 256 KB. Settings uses the Umbratic mark, includes an X as well as the bottom-left close control, and omits executable and tool-visibility controls. Activity remains visible and individually expandable.

The follow-up native app check selected Fable 5.1 from the live catalog and completed a read-only file tool turn. Its response link opened the new preview. After the turn, Claude returned five-hour and weekly subscription windows (49% left in the tighter window at the time of verification). Initial fresh-process quota reads still sometimes return null; the app does not manufacture a value in that case.

The follow-up passed the root `npm run test:all` suite (793 desktop tests) and the desktop production build. UI verification covered the original broken Codex file-link response, links in both selected roots, Fable selection and tool use, both providers’ real usage rings, both appearances, and the Settings X.

### Provider conversations and composer controls

Cloud stores provider-owned conversations in Umbratic's SQLite state. Switching providers selects that provider's archive without transferring messages or session references. Continuing a chat resumes its own native session, preserving the runtime's cache behavior. A bounded same-provider handoff is used only if that chat's native continuation must be recovered. Old shared conversations migrate once to their last active provider, retaining the visible transcript and only that provider's native session reference. Existing provider-separated histories remain available. Native credentials and session files remain managed by the official runtimes in their own locations.

The composer reuses the local dictation hook, device picker, voice settings, attachment strip, and prompt keyboard behavior. Cloud explicitly selects the local speech path even when Private uses a server. No provider transcription API or API credits are used. A local speech model must be downloaded and selected in Voice settings first. Images appear inside the composer immediately, with no attaching caption; their previews dismiss on outside click. The plus control also accepts PDFs and UTF-8 text/code files. Claude receives native image/document blocks; Codex receives native local-image inputs or app-owned document paths for its file tools.

Codex offers Ask for approval and Approve for me, mapping to `user`/`auto_review` with the existing sandbox retained. Its former full-access preference migrates to manual. Claude offers Manual, Auto, and Bypass, mapping to its native default, auto, and bypass modes; dangerous bypass is enabled only for that selected mode. The Codex speed menu uses service tiers returned by `model/list`; Claude has no speed control. These controls do not alter global runtime settings.

The native Fable smoke test returned `claude-fable-5-1` as the actual assistant model, matching the SDK catalog, and correctly identified a synthetic blue image. After a turn, the signed-in Claude runtime returned five-hour, weekly, and Fable-weekly quotas. Fresh-process inspection and `/usage` still sometimes return null before inference; this is not converted to a fake quota. Recent successful account-scoped readings survive these empty refreshes. Unknown context/usage UI is hidden. Every window returned by either provider is displayed in usage details, with one percentage per meter. No direct OAuth token extraction or private usage endpoint is used.

Sources checked: [Claude SDK structured usage](https://code.claude.com/docs/en/agent-sdk/typescript), [Claude permissions](https://code.claude.com/docs/en/permissions), [Codex app-server](https://learn.chatgpt.com/docs/app-server), and [Codex automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review). Claude's SDK explicitly documents that a usage report can be null when its usage fetch fails or the authentication lane lacks profile scope; a null result alone does not identify which cause applies.

Historical checks for the earlier shared-conversation implementation: the root suite passed with 797 desktop tests plus the native/workspace checks and production build. Native UI tests verified image thumbnails, image inspection through Fable, outside-click dismissal, one Settings close button, one Voice heading, microphone enumeration, and confirmation/cancellation of context reset. That version exercised cross-provider handoff; the unified workspace deliberately replaces it with provider-isolated archives. The tested Codex account reply contained one weekly window (10,080 minutes) and a null secondary window; the app did not add a fictitious five-hour meter. The live model catalog offered Standard and Fast for the selected Codex model. No full-access or bypass mode was enabled on the user's behalf during verification.


### Workspace scope, dictation, and rendered answers

Both runtimes now receive the same explicit peer-folder workspace instructions. Broad codebase questions ask them to inspect every selected root, identify the components and relationships, and say which roots were not inspected. Folder-specific requests retain their narrower scope. Native tool access still uses Codex writable roots and Claude additional directories. A live smoke test with two disposable folders (a frontend and a queue worker) confirmed both Codex and Claude described both components without the user naming the second root.

Development Electron builds now resolve the repository’s prepared, pinned speech runtime when packaged resources are absent. Packaged resources and an explicit override retain priority; arbitrary system executables are never discovered. The local Qwen3 ASR 0.6B runtime successfully transcribed a synthesized sentence through the app’s actual speech service. Cloud errors reuse the shared bottom-right toast and leave the composer’s layout unchanged.

The shared Markdown renderer now renders Mermaid diagrams locally, including streamed responses, with source/copy controls and a code fallback for invalid syntax. The dependency is lazy-loaded; strict sanitization, bounded diagram size/edges, and SVG image isolation keep diagram code separate from the application document. Package licenses and upstream source notices ship in `assets/diagram-notices.txt`. Table file links remain on one line, with horizontal overflow available when needed. Implementation references: [Mermaid usage](https://mermaid.js.org/config/usage) and [configuration](https://mermaid.js.org/config/schema-docs/config.html).

The folder menu omits the selected count and uses an accessible plus-only add action. Usage details omit the redundant “Remaining” caption. Claude permissions offer Manual, Auto, and Bypass; Codex now has only Ask for approval and Approve for me. Browser/native visual checks covered these controls, toast placement, the originally reported Mermaid diagram, and unbroken table filenames. The root suite passed with 801 desktop tests, native/workspace checks, and the production build.

The unsigned macOS package and `verify:package` also passed. Archive inspection confirmed the Mermaid chunks and dependency license notices are present. No public release was published.


### Shared interaction polish and source previews

The shared feedback dialog now shows a short, unambiguous filename, compact line reference, and comment. Full paths remain available on hover. It closes on Escape or outside click, and other app shortcuts cannot open a second modal behind it. The folder picker keeps a stable alphabetical order, shows paths only to disambiguate duplicate names, and places its plus action in the header. Folder, model, approval, and microphone menus share a restrained translucent surface and opaque accessibility fallbacks.

All providers use the saved shortcut registry for Settings, Keyboard settings, new/delete chat, prompt focus, review, dictation, and stop. The shared editable Keyboard page filters actions to the active provider's supported features. Hints use the saved bindings and send preference, including inside native dialogs. Only the visible workspace handles shortcuts; switching providers preserves drafts and active work.

File links include their cited line. The preview has a minimal filename header, a highlighted gutter, and a readable monospace source view. The folder subtitle and line badge are omitted. Uncited files open at the top. Syntax colors come from local [Shiki TextMate grammars](https://shiki.style/guide/), loaded on demand and tokenized in a worker. Light and dark tokens are rendered as text spans; unknown languages fall back to plain text. This is syntax highlighting, not diagnostics or a language server. The existing workspace boundaries and 256 KB preview limit remain in force. Original dependency notices are included in `assets/syntax-notices.txt`.

The shared Mermaid renderer uses a custom [base theme](https://mermaid.js.org/config/theming.html), readable text sizing, and an expanded view with zoom. Very wide horizontal flowcharts use a vertical presentation without changing their nodes, relationships, or copyable source. Rendering remains local and isolated in an SVG image.

Verification: `npm run test:all` passed, including 808 desktop tests, native/workspace checks, and the production build. Targeted syntax tests cover source preservation, multiline comments, distinct token colors, multiple grammars, and unknown-language fallback. Browser checks covered light/dark source, cited/uncited opening positions, outside dismissal, two Codex approval choices, diagram expansion/zoom, folder menus, shared feedback, and Private/Cloud keyboard settings. An isolated Electron window loaded a production-built fixture from `file://` with the application's CSP and confirmed the syntax worker and lazy grammars work without a development server. The unsigned macOS package and `verify:package` passed; archive inspection confirmed the worker, C/TypeScript grammar chunks, and syntax notices. No public release was published.


The same syntax palette now applies to fenced AI code blocks and review diffs in both Private and Cloud. A shared worker serializes requests, drops superseded queued work, coalesces identical requests, and retains a bounded cache. Streaming text appears immediately; completed syntax tokens are reused only on lines whose text still matches. Unknown languages remain plain text. Review tokenization keeps before/after excerpts and separate hunks independent, then combines syntax spans with the existing changed-word marks without altering source text or review line selection.

### Live activity and context deletion

Cloud and Private working blocks stay open during a run. Tool rows show commands and file actions directly; four or more consecutive actions share a compact disclosure, with current actions still visible live and detailed output available on demand. At completion, progress folds into a reopenable “Worked for…” block above the answer. Codex message phases, readable summaries, and command-output deltas are retained using the [app-server event contract](https://learn.chatgpt.com/docs/app-server). Claude text, available thinking text, and tool inputs stream as partial events arrive; tool-result text appears when the SDK supplies it. Completion is published before quota refresh, with a stable completion timestamp.

Umbratic keeps Cloud history locally in `state/umbratic.sqlite`, in `settings` records named `cloud:workspace:<hash>`. Attachment copies and previews live in `cloud/images`. On macOS these are under `~/Library/Application Support/Umbratic/`. Cloud inference continues through the official provider runtimes, without sending these transcripts to Veil.

Manual reset and chat deletion remove only the selected chat's record and unused attachment copies. References from other chats and attachments for the incoming turn are preserved. Inactivity renewal forgets the selected native session while preserving the saved conversation. These actions do not delete provider-managed session files or provider-side history; the confirmation dialog states that distinction. Migration retains existing user history.

Run approvals and speed now sit inside the composer. A compact footer aligns Settings, quota/context meters, and reset. The Settings panel groups connected accounts and explains the context reset behavior.

Shared-syntax verification: the root suite passed with 815 desktop tests plus native/workspace checks and the production build. Added coverage checks language aliases, cancellation, coalescing, failure recovery, exact text preservation, HTML escaping, and before/after hunk mapping. Visual checks covered AI code and review diffs in both modes, light/dark contrast, preserved changed-word marks, and the simplified file header. An isolated Electron window confirmed response and review highlighting from production-built local assets with the app's normal CSP.

Connected accounts can be disconnected from Providers settings. Disconnect uses the official runtime’s sign-out operation, clears Umbratic’s cached account usage and resume references for that provider, and keeps saved conversations. The other provider stays connected.

## Unified workspace verification, November 3, 2026

The desktop production build, TypeScript checks, native tests, and source-size checks pass. The root verification suite was run; the final desktop suite passes 841 of 842 tests. The remaining Metal-kit packaging test requires Python 3.12.16+, 3.13.18+, 3.14.10+, or 3.15.2+ in those release series; installed interpreters do not meet that prerequisite. The Veil and console suites also pass when run separately after that stop. No test was skipped or weakened.

Browser checks use deterministic preview data, with no real provider calls. They cover independent provider drafts, new-chat creation, streaming while switching providers, local review, shared settings, light/dark appearance, and desktop/compact layout. Native subscription inference was not repeated for this UI consolidation; the older live checks above document the previous runtime verification.
