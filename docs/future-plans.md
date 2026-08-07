# Future Plans

Server-side features planned for Veil and Veil Console. Everything here builds on
the wire-compatibility contract (see `AGENTS.md`): the harness ships fast and
additively, the company Veil accepts any harness vocabulary within bounds, and
server behavior changes ship as an occasional Veil/Console release zip. Because
prompts, playbooks, and RAG injection are all server-side, every feature below
reaches **every harness version ever shipped** with zero client changes.

Each shipped feature adds a name to the `/api/health` `features` list so newer
desktops can surface matching UI and older desktops lose nothing.

## 1. RAG on the company server (main goal)

Company-wide retrieval: admins upload documents in Veil Console, Veil injects
relevant chunks into every user's requests.

### Ingestion (Veil Console)

- Console page: upload documents (start with `.md`/`.txt`, then `.pdf` — the
  repo already extracts PDF text in Rust for the desktop; server-side start
  simple), list, delete, tag by route (engineering / marketing / sales / all).
- Pipeline: extract text → chunk (fixed size with overlap, per-chunk source
  metadata) → embed → store.
- Embeddings come from the company's own runtime. The admin picks an embedding
  model in Console next to the chat model (Ollama `/api/embed`, vLLM
  `/v1/embeddings`). Console already talks to the runtime for probes, so
  ingestion-time embedding calls live in Console.
- Corpus and ingest state live in `console.db` (SQLite already in use there).
  Store the embedding model id and dimensions with the corpus; changing the
  embedding model triggers a Console-driven re-embed of the whole corpus.

### The index artifact (how Veil reads it)

Veil is Go-stdlib-only and must stay that way, so Veil does not read SQLite.
Console **exports a compact index file** — chunks, float32 vectors, source
metadata, embedding model id, checksum — to a path handed to Veil as
`VEIL_RAG_INDEX_PATH`. This is the template-registry pattern
(`internal/templates/templates.go`) scaled up: validated file, loaded into
memory at startup, restart-to-apply through the existing supervisor apply flow.

Veil scores by brute-force cosine in memory. At realistic corpus sizes
(~10k chunks × 1024 dims ≈ 40 MB of vectors) this needs no ANN index and no
vector-database dependency. Cap corpus size in Console; revisit ANN only if a
customer actually outgrows the cap.

### Retrieval (Veil, request time)

- Veil embeds the query (last user message, or the orient result) via the
  runtime — Veil already owns all runtime calls, so this is one new model-client
  method.
- Top-k chunks are injected as an **untrusted content overlay** with source
  names for citation — same authority level as the template registry overlay,
  never as protected prompt text.
- Config: enable per route, top-k, injected-byte budget (must respect the
  model's context length). All set in Console, applied on Veil restart.

## 2. Company system prompt editable in Veil Console

Split the prompt into two layers:

- **Base protected prompt** — ours. Stays compiled into the Veil binary
  (`internal/prompts/prompts.go`). It encodes harness behavior (tools, playbook
  framing, safety) that we tune alongside the runner; customers editing it would
  break the product we are responsible for. It updates when we ship a Veil
  release — that is fine at a slow cadence.
- **Company overlay** — theirs. A Console-edited text block (tone, internal
  terminology, company policies, "who we are") appended to the protected prefix
  on every request. Stored in `console.db`, handed to Veil as a file path
  (`VEIL_COMPANY_PROMPT_PATH`), applied via the existing restart flow.
  Byte-capped, audit-logged on every edit.

This gives customers real customization without giving them the keys to the
harness contract, and it means "give them a new binary for the system prompt"
is only ever needed for *our* base prompt.

## 3. Buckets and playbooks in Console: recommendation — no

Buckets/playbooks are harness tuning, tightly coupled to the runner loop and
tool behavior. They should keep shipping inside the Veil binary, updated when we
update the harness. From a customer standpoint the customization need is already
covered by the company overlay prompt and RAG.

The tolerant `harness_bucket` contract (hints, not enums) leaves the door open:
if a customer case ever demands it, Console could let admins map **additional**
company-defined hints to company playbooks — additions only, never edits to
ours. Deferred until a real customer asks.

## 4. Telemetry browsing and export on the server

Today telemetry bundles land as JSON files in `VEIL_TELEMETRY_STORE_PATH` with
retention pruning, and Console's `audit_events` table is write-only. Add to
Console:

- A telemetry page: list bundles by date, per-bundle summary (task counts,
  event counts, dropped-record counts from the tolerant validator).
- Export: date-range download as a zip of JSON (and a flattened CSV of product
  events for spreadsheet use).
- An audit-log viewer for `audit_events` (or an explicit code comment that the
  table is operator-read-only via `sqlite3` — currently it is neither).
- Later: an aggregate dashboard (tool failure rates, context-pressure triggers,
  feedback ratings). Because the telemetry vocabulary is open, events added by
  newer harnesses are already in the stored bundles before the dashboard knows
  how to chart them — a Console update can visualize data retroactively.

## 5. Prerequisites and supporting work

- **`console.db` migrations**: replace the destructive `migrateConfigurations`
  (drops the admin's saved config) with an additive migration mechanism before
  customer installs proliferate. Required for RAG/prompt/telemetry tables.
- **Template registry activation**: Console management UI for the existing
  registry — it is the general "push versioned content to Veil without
  recompiling" channel and the delivery mechanism for the overlay/index files
  above.
- **Feature names**: each feature ships a capability name (`rag`,
  `company-prompt`, `telemetry-export`) in `/api/health` so desktops can gate UI.
- **`docs/storage-layout.md`**: write it (README links to it; it does not
  exist). Server paths gain the RAG corpus/index locations.
- **Parked**: installer signing/notarization and desktop auto-update
  (electron-updater over GitHub Releases). Not scheduled; blocked on signing
  certificates, not on design.
