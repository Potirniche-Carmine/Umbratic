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

Admins upload company documents in a new Veil Console **Documents** tab, tagged
by route (**engineering / sales / marketing / all**). Veil retrieves the chunks
relevant to the active route from a local Qdrant instance and injects them into
the request as an untrusted overlay with source citations.

**Zero harness changes.** The route signal already exists on the wire: the
runner posts to `/api/engineering/chat`, `/api/marketing/chat`, or
`/api/sales/chat` (`internal/http/server.go`, route allowlist in
`packages/runner/src/veil_client.rs`). Veil filters retrieval to
`route ∈ {request route, all}` — sales users never see engineering-only chunks
and vice versa. Every harness ever shipped gets RAG the day the server updates.

### Architecture at a glance

```
admin ──upload──▶ Console ──extract → chunk──▶ embeddings (runtime) ──upsert──▶ Qdrant
                                                                                  │
user ──POST /api/<route>/chat──▶ Veil ──embed query──▶ search (route filter) ◀────┘
                                   │
                                   └─ top-k chunks → untrusted overlay → model
```

Console owns ingestion (it already talks to the runtime for probes). Veil owns
request-time retrieval (it already owns all model calls). Qdrant is the only
new process, localhost-only, installed by the same `install.sh`.

### Vector database: Qdrant (decision, August 2026)

Researched the self-hosted landscape as of August 2026. **Qdrant v1.19.0**
(released 2026-08-05) is both the lightweight choice and the industry-standard
one for this deployment shape:

- Single static Rust binary, no external dependencies — matches our
  one-binary-per-service deployment. Official `.deb` and prebuilt Linux
  binaries on GitHub releases; runs fine under systemd without Docker.
- Plain REST API (JSON over HTTP on `127.0.0.1:6333`) — callable from Veil with
  **Go stdlib only** (`net/http` + `encoding/json`), preserving Veil's
  zero-dependency `go.mod`. Console (also Go) uses the same API for upserts.
- First-class payload filtering — the route split is one indexed keyword field,
  filtered at search time (`"match": {"any": ["sales", "all"]}`).
- Low idle footprint, quantization if a corpus ever gets big, snapshot API for
  backups, `telemetry_disabled: true` config for privacy, Apache-2.0.

Alternatives considered and rejected for this stack: **Chroma** (Python server —
wrong runtime for a Go/systemd/no-Docker stack; positioned for prototyping),
**Weaviate** (heavier, module system we don't need), **Milvus** (Kubernetes-scale
ops burden; built for billions of vectors), **pgvector** (would introduce
Postgres next to a SQLite stack), **sqlite-vec** (embedded and excellent, but
Veil cannot read SQLite without CGO, and serving one index to two processes
brings back the export-file dance below).

This supersedes the earlier "index file + brute-force cosine in Veil" design.
Qdrant costs one more systemd unit but removes the worst property of the index
file: restart-to-apply. With Qdrant, an uploaded document is searchable on the
next chat request — no Veil restart, no export step, and incremental
add/delete/retag instead of whole-corpus rewrites.

Research sources: [Braintrust — best vector DBs for RAG 2026](https://www.braintrust.dev/articles/best-vector-databases-for-rag-2026),
[Firecrawl — vector DB comparison](https://www.firecrawl.dev/blog/best-vector-databases),
[Qdrant releases](https://github.com/qdrant/qdrant/releases),
[Qdrant on Ubuntu without Docker](https://computingforgeeks.com/install-qdrant-ubuntu/).

### Ingestion (Veil Console — "Documents" tab)

New page following the existing Console page pattern: template
`internal/web/templates/documents.html` + nav entry in `brand.html`, handlers on
the `ServeMux` wrapped in `requireSession`, mutations through
`validateFormRequest` + `store.Audit`. One new wrinkle: Console has no upload
machinery today, so this adds `ParseMultipartForm` handling (with a multipart
variant of the form-validation content-type check) and per-file/aggregate size
caps.

UI, one page, four sections — **Engineering / Sales / Marketing / All routes**:

- Drag-drop or file-picker upload into a section (the section sets the route
  tag; a document can be retagged later).
- Accepted types: `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.md`, `.txt` — sniffed by
  content, not extension, and capped at 25 MiB per file (matching the PDF
  crate's `DEFAULT_MAX_BYTES`).
- Per-document row: name, type, route, status
  (`pending → processing → indexed | failed`), chunk count, uploaded-at, and
  actions: delete, retag, re-index. Failures show the extraction error.
- Corpus header: total documents/chunks against caps (start: 1,000 docs,
  100k chunks ≈ 400 MB of 1024-dim f32 vectors), embedding model in use.

Extraction — Console is Go with a three-dependency policy, so:

- `.md` / `.txt` — read as-is (UTF-8 validate, strip control chars).
- `.pdf` — reuse the existing Rust extractor: ship `umbratic-pdf` (crate
  `packages/pdf`, lopdf-based, already emits markdown + JSON on stdout) as a
  linux-amd64 binary in the release zip; Console spawns it exactly the way the
  desktop already does in `apps/desktop/src/main/pdfInspector.ts`. Hostile-input
  handling (`catch_unwind`, byte/page caps) comes for free.
- `.docx` / `.pptx` / `.xlsx` — OOXML is ZIP + XML, and Go's stdlib has
  `archive/zip` + `encoding/xml`. A small `internal/extract` package in Console
  reads `word/document.xml` text runs, `ppt/slides/slide*.xml`, and
  `xl/sharedStrings.xml` + worksheet cells. No new dependency; hardened like
  the rest of Console (decompressed-size caps, entry-count caps, no external
  entity resolution — `encoding/xml` does none by default).

Pipeline (async worker goroutine in Console, one document at a time):

1. Store the original under `/var/lib/veil-console/documents/<doc-id>` (already
   inside the unit's `ReadWritePaths`; originals make re-embedding possible
   without re-upload).
2. Extract text → chunk: fixed-size ~1,800 chars with ~200 overlap, split on
   paragraph boundaries where possible; each chunk carries `doc_id`, `doc_name`,
   `route`, `chunk_index`, and a section locator (page for PDF, slide for PPTX,
   sheet + row range for XLSX, nearest heading for MD/DOCX).
3. Embed each chunk via the runtime (below), batched.
4. Upsert to Qdrant collection `company_docs_v1`: vector + payload
   `{route, doc_id, doc_name, section, chunk_index, text, embedding_model}`.
   Chunk text lives **in the Qdrant payload**, so Veil never reads `console.db`.
5. Mark `indexed` with chunk count; audit-log the event (as with every
   mutation: upload, delete, retag, re-index, settings change).

Console-side state: two new tables via the additive-migration mechanism (§6) —
`documents` (id, name, type, route, status, error, chunk_count, sha256,
uploaded_at) and `rag_settings` (embedding base URL, embedding model, learned
dimension, qdrant URL, enabled flag, top-k, injection byte budget). Delete =
remove Qdrant points by `doc_id` filter + remove original + row.

### Embeddings (the one genuinely new runtime requirement)

**The company server runs vLLM only.** Ollama is the desktop/local-harness
runtime (`ModeLocal` in Veil) and appears nowhere in the server story — Console
already hardcodes `VEIL_MODE=server`. Don't let the two deployment stories
blur.

vLLM serves **one model per instance**, so the chat instance cannot also
embed. The Documents tab therefore gets its own *embedding model* setting next
to the chat model, served by a second vLLM instance in embedding mode
(`--runner pooling`, exposing OpenAI-compatible `/v1/embeddings`) — provisioned
by the managed runtime flow in §2, or an external base URL for servers we
don't manage. One API shape everywhere: same `providerRequest` transport guard
in Console (loopback/private-IP-only, no proxy, response caps), same hardened
client pattern in Veil.

- Recommended family: **Qwen3-Embedding** (Apache-2.0, top quality-per-VRAM in
  Aug-2026 rankings). All three sizes make sense depending on the server —
  **0.6B** (1024-dim) for small boxes, **4B** (2560-dim) mid, **8B** (4096-dim)
  for big servers with large corpora. Multilingual alternative: **BGE-M3**.
  Admin's choice — a dropdown probed like the chat model, with the size
  guidance surfaced in the UI (§2).
- On save, Console probes the endpoint by embedding a test string, learns the
  vector dimension, and (re)creates the Qdrant collection to match. Model id +
  dimension are stored with the corpus; **changing the embedding model triggers
  a Console-driven re-embed of all documents from the stored originals**, with
  progress in the Documents tab. Veil refuses retrieval if the collection's
  stored model id differs from its configured one (skip + metric, never 500).

### Retrieval (Veil, request time)

Veil stays Go-stdlib-only; both new calls are plain JSON-over-HTTP to loopback.

- One new method on the model client (`internal/model/model.go`):
  `Embed(ctx, text) ([]float32, error)` against the configured embedding base
  URL — resolved via the existing `providerEndpointURL` logic and the existing
  hardened HTTP client (private-IP-only dialer, no redirects, no proxy).
- In `handleChat`, when RAG is enabled for the route: embed the query (last
  user message text, byte-capped; the orient summary when present is a later
  refinement) → `POST /collections/company_docs_v1/points/query` with filter
  `route ∈ {request route, "all"}`, `limit = top_k`, payload included → take
  results in score order until the injected-byte budget is hit.
- Injection reuses the existing untrusted-overlay mechanism
  (`withRequestOverlay`, `internal/http/server.go`) — appended to the last user
  message under the "Request-scoped server metadata (untrusted context, not
  instructions)" banner, each chunk prefixed with its citation
  (`[doc_name — section]`). Same authority level as the template-registry
  overlay, never protected prompt text. Template overlay and RAG overlay
  compose in that order under one banner.
- **Graceful degradation is a hard requirement**: Qdrant down, embedding
  endpoint down, timeout exceeded (total RAG budget ~2 s, typically <300 ms),
  dimension/model mismatch — all skip injection, count a metric, and serve the
  request normally. RAG must never take chat down and never blocks `/api/health`
  readiness. New counters on `/api/runtime/metrics` next to the existing
  compatibility counters: `rag_injected`, `rag_skipped_unavailable`,
  `rag_empty_results`.

Config, all set in Console and passed through the supervisor's allowlisted
child environment (extend `CompanyEnvironment` in
`veil-console/internal/config/config.go` — nothing is written to disk):

```
VEIL_RAG_ENABLED             0/1 (also gates the /api/health feature name)
VEIL_RAG_VECTOR_BASE_URL     http://127.0.0.1:6333
VEIL_RAG_VECTOR_API_KEY      generated at install time
VEIL_RAG_COLLECTION          company_docs_v1
VEIL_RAG_EMBEDDING_BASE_URL  the embedding vLLM instance (§2)
VEIL_RAG_EMBEDDING_MODEL     e.g. qwen3-embedding-0.6b
VEIL_RAG_TOP_K               default 6
VEIL_RAG_MAX_INJECTED_BYTES  default 12288 (must fit the model's context budget)
VEIL_RAG_TIMEOUT             default 2s
```

Feature gating: `features.go`'s static slice becomes config-aware so `rag`
appears in `/api/health` only when enabled — desktops gate any RAG UI on the
name (mirror it in `apps/desktop/src/main/veilFeatures.ts`), and per the
compatibility contract, discovery is by feature name, never version.

### Installer packaging (one-stop shop on Ubuntu)

Qdrant ships **inside the release zip** rather than being downloaded at
install time — sha256-pinned at build time, immune to upstream changes, and
still air-gap friendly. (Other install steps do use the network — §2 has
`install.sh` set up Docker — but every service we supervise ships pinned in
the zip.) `build-release-zip.sh`
adds: the `qdrant` linux-amd64 binary (fetched from the official GitHub release
at build time, checksum-verified), `qdrant-config.yaml.template`, and
`qdrant.service.template`; all listed in `SHA256SUMS`. Zip grows ~50 MB —
acceptable.

`install.sh` additions, same idempotent style as the existing steps:

1. Create system user `qdrant` (no shell, no home) if missing.
2. `install -d -m 0700 -o qdrant /var/lib/qdrant`.
3. Install the binary to `/opt/umbratic/qdrant/qdrant`.
4. Generate an API key (`head -c32 /dev/urandom | sha256sum`), render
   `/etc/qdrant/config.yaml` (mode 0600, owner qdrant): bind `127.0.0.1:6333`,
   gRPC disabled, `storage_path: /var/lib/qdrant/storage`,
   `snapshots_path: /var/lib/qdrant/snapshots`, `telemetry_disabled: true`,
   the API key. Write the key a second time to
   `/var/lib/veil-console/qdrant-api-key` (0600, owner veil-console) — Console
   reads it at startup and passes it to Veil via the child environment.
5. Install `qdrant.service` (hardening mirroring the Console unit:
   `ProtectSystem=strict`, `ReadWritePaths=/var/lib/qdrant`, etc.);
   `systemctl enable --now qdrant`; wait on `127.0.0.1:6333/readyz`.
6. Add `Wants=qdrant.service` / `After=qdrant.service` to
   `veil-console.service` (Veil degrades gracefully anyway; this just orders
   normal boots).

The model runtime itself is no longer the admin's problem either — that's the
managed vLLM flow in §2, which adds its own (preflight-only) installer checks.

### Milestones

1. **Corpus plumbing** — migrations mechanism (§6) + `documents`/`rag_settings`
   tables, Documents tab with `.md`/`.txt` upload, chunking, embedding-endpoint
   settings + probe, Qdrant upsert/delete/retag. *Accept: upload → `indexed`
   with chunk count; delete removes points; dev Qdrant via
   `scripts/run-veil-console.ts`.*
2. **Retrieval** — Veil `Embed` client method, query + route filter, overlay
   injection, degradation paths, metrics, `rag` feature name. *Accept: same
   question on `/api/sales/chat` vs `/api/engineering/chat` retrieves only
   route-appropriate chunks with citations; killing Qdrant mid-session leaves
   chat working with `rag_skipped_unavailable` incrementing.*
3. **All formats** — `umbratic-pdf` in the zip + spawn path; stdlib OOXML
   extractors for `.docx`/`.pptx`/`.xlsx` with hostile-input caps and section
   locators. *Accept: fixture of all six types round-trips to cited chunks.*
4. **Packaging** — installer steps above, re-embed-on-model-change flow,
   `docs/storage-layout.md` (§6). *Accept: fresh Ubuntu box → one `install.sh`
   run → upload → routed retrieval, all services surviving reboot.*

## 2. Managed vLLM runtime: pick a Hugging Face model, Console does the rest

Getting vLLM serving a model is the hardest step of the install today — the
one thing `install.sh` punts on ("Ollama or vLLM must run locally before you
configure Veil", and per §1, on the company server it is really just vLLM).
Replace it with a managed flow: the admin supplies a Hugging Face repo id,
Console runs the vLLM Docker container in the background and wires everything
up.

### Admin experience

Kept deliberately simple — three inputs, one button, no hidden machinery:

1. **Hugging Face token** — one field in Settings (created at
   huggingface.co/settings/tokens; stored 0600 like Console's other secrets,
   never logged). Sign in right after setup: it unlocks gated models, and
   authenticated downloads are materially faster — anonymous requests get the
   throttled rate limits. The install output points the admin at this step.
2. **Model reference**, agnostic to weight format:
   - **Standard vLLM weights (safetensors)** — the normal path. Choose the
     quantization by choosing the repo (e.g. `Qwen/Qwen3-32B-AWQ`,
     `RedHatAI/Meta-Llama-3.1-70B-Instruct-quantized.w4a16`, or an FP8
     variant); vLLM auto-detects the quantization from the repo's config.
   - **GGUF** — vLLM's `repo:QUANT` form (e.g.
     `unsloth/Llama-3.1-8B-Instruct-GGUF:Q8_0`) plus a base-model tokenizer
     repo (vLLM's own recommendation — GGUF tokenizer conversion is
     unstable). Requires `vllm-gguf-plugin`, handled by a documented manual
     step (below), and labeled in the UI with vLLM's own caveat: experimental
     and under-optimized — prefer safetensors repos when both exist.
3. **Deploy.** Console pulls the pinned `vllm/vllm-openai` image and starts
   the container; the container downloads the weights itself into the mounted
   cache volume (standard vLLM behavior — no host-side download tooling).
   Console streams the container logs into the page so pull and startup
   progress are visible, waits for readiness, runs the existing
   `TestProvider` probes (streamed completion + strict tool call), and fills
   in the provider base URL itself.

The Documents tab (§1) gets the same flow for the embedding model, with the
Qwen3-Embedding size guidance from §1 shown inline.

Manual mode — pasting an external base URL, today's behavior — remains the
escape hatch for servers whose runtime we don't manage, including air-gapped
installs: the managed flow needs network access to Docker Hub and Hugging Face
at *configure* time (never at request time).

### The exact commands (full, visible, no magic)

**The UI always shows the complete `docker run` command it is about to
execute** — rendered in a read-only code block on the settings page, updating
live as fields change (token redacted), and the same string is written to the
audit log on deploy. What the admin sees is exactly what runs.

Chat model, full command with defaults filled in:

```bash
docker run -d \
  --name umbratic-vllm-chat \
  --restart unless-stopped \
  --runtime nvidia \
  --gpus all \
  --ipc=host \
  -v /var/lib/umbratic-models:/root/.cache/huggingface \
  --env "HUGGING_FACE_HUB_TOKEN=<token from Console settings>" \
  -p 127.0.0.1:8000:8000 \
  vllm/vllm-openai:v0.12.0 \
  --model Qwen/Qwen3-32B-AWQ \
  --served-model-name company-chat \
  --gpu-memory-utilization 0.80 \
  --max-model-len 32768
```

Embedding model (note `--runner pooling`, and host port 8001 mapping to the
container's 8000):

```bash
docker run -d \
  --name umbratic-vllm-embed \
  --restart unless-stopped \
  --runtime nvidia \
  --gpus all \
  --ipc=host \
  -v /var/lib/umbratic-models:/root/.cache/huggingface \
  --env "HUGGING_FACE_HUB_TOKEN=<token from Console settings>" \
  -p 127.0.0.1:8001:8000 \
  vllm/vllm-openai:v0.12.0 \
  --model Qwen/Qwen3-Embedding-0.6B \
  --runner pooling \
  --gpu-memory-utilization 0.10
```

GGUF chat model — same container shape, only the model arguments change:

```bash
  ... \
  vllm-gguf:v0.12.0 \
  --model unsloth/Llama-3.1-8B-Instruct-GGUF:Q8_0 \
  --tokenizer meta-llama/Llama-3.1-8B-Instruct \
  --served-model-name company-chat \
  --gpu-memory-utilization 0.80
```

where `vllm-gguf:v0.12.0` comes from the one documented manual step (GGUF
support lives in a plugin, and we keep deployment simple rather than building
images automatically):

```bash
printf 'FROM vllm/vllm-openai:v0.12.0\nRUN pip install vllm-gguf-plugin\n' | docker build -t vllm-gguf:v0.12.0 -
```

**Custom parameters, for everything the defaults can't know.** Next to the
model field, an advanced disclosure with three free-text fields: *image
override*, *extra `docker run` args*, and *extra vLLM args* — all reflected in
the rendered command block before anything runs. The defaults stay basic and
NVIDIA-shaped; the override fields cover the rest without new UI per GPU
vendor. AMD, as a documented manual recipe: image `vllm/vllm-openai-rocm`
(official upstream since Jan 2026) and

```
--device /dev/kfd --device /dev/dri --group-add video
```

as extra `docker run` args in place of `--runtime nvidia --gpus all`. Override
values are stored with the container spec, audit-logged, and require the same
fresh-password confirm as other dangerous settings (they execute with Docker's
authority — an admin-only power, stated as such in the UI).

Details that make this "correct by default":

- `--gpus all` (NVIDIA Container Toolkit) is mandatory; `--ipc=host` (or a
  large `--shm-size`) is required for NCCL when tensor-parallel; Console
  surfaces `--tensor-parallel-size` when it detects more than one GPU.
- Quantization is auto-detected from the repo's config in current vLLM — the
  explicit `--quantization` override is an advanced field, not the normal path.
- `--runner pooling` is the current flag for embedding mode serving
  `/v1/embeddings` (it replaced the older `--task embed`).
- `--max-model-len` defaults from the configured `VEIL_CONTEXT_LENGTH` so GPU
  memory isn't reserved for context nobody uses.
- The two containers split the GPU via `--gpu-memory-utilization`
  (0.80 / 0.10 defaults, admin-tunable); weights persist in the
  `/var/lib/umbratic-models` volume across restarts; both publish to loopback
  only, which also satisfies Veil's and Console's private-address-only dialers.

### Mechanics in Console (no new dependency)

Console drives the **Docker Engine API over `/var/run/docker.sock`** — HTTP
over a unix socket, which Go's stdlib handles with a custom `DialContext`; no
Docker SDK. Image pull, create, start, stop, remove, logs, and inspect are the
whole surface. Readiness = polling the container's `/health` then
`/v1/models`, exactly like `waitForHealth` does for Veil. Container specs live
in `console.db`; *replace model* runs under the supervisor's existing
exclusive-action lock with the same candidate/rollback shape as `Apply`: the
old container is kept until the new one passes probes, then removed.

Security tradeoff, stated plainly: `veil-console` joins the `docker` group,
which is root-equivalent on the host. Acceptable for a single-purpose
appliance box, but documented loudly, and the socket is never exposed over
TCP. If a customer needs tighter containment later: a socket proxy
allowlisting those endpoints, or rootless Docker — deferred.

### Installer additions (Docker installed for you)

The one-stop-shop promise extends to the runtime plumbing — `install.sh`
installs it rather than just checking for it:

1. **Docker Engine** from Docker's official apt repository (skipped when
   `docker info` already succeeds).
2. **NVIDIA Container Toolkit** when an NVIDIA GPU is detected
   (`nvidia-smi` present), then a smoke test:
   `docker run --rm --gpus all <image> nvidia-smi` — failure prints the fix
   and aborts before anything else changes. AMD boxes skip this and use the
   custom-parameters ROCm recipe above.
3. `/var/lib/umbratic-models` created; `veil-console` added to the `docker`
   group.

Nothing else — weight downloads happen inside the vLLM container, so no
host-side Hugging Face tooling is installed. GPU *drivers* remain the host's
responsibility (kernel-specific, may need a reboot) — the installer detects
and says exactly what's missing. The final install output tells the admin the
two follow-ups in order: open Console, and **sign in to Hugging Face first**
(token field in Settings) so model downloads run at authenticated speed.
Air-gapped installs skip all of this and use manual mode with a preinstalled
runtime, as today.

*Accept: fresh Ubuntu box with GPU drivers → one `install.sh` run → sign in
to Hugging Face in Console → paste two repo ids → chat and Documents both
green without the admin ever opening a shell to the runtime; a GGUF
`repo:QUANT` reference works after the documented one-line image build;
`kill -9` on a container and it
returns via `--restart unless-stopped`; a bad model swap rolls back to the
previous container on probe failure.*

Sources: [vLLM Docker deployment docs](https://docs.vllm.ai/en/stable/deployment/docker/),
[vLLM embedding serving](https://docs.vllm.ai/en/latest/models/pooling_models/embed/),
[`--runner pooling` migration note](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/discussions/50),
[vLLM GGUF support](https://docs.vllm.ai/en/latest/features/quantization/gguf.html),
[ROCm vLLM images (official upstream since Jan 2026)](https://rocm.docs.amd.com/en/latest/how-to/rocm-for-ai/inference/benchmark-docker/vllm.html),
[vLLM production deployment guide 2026](https://www.sitepoint.com/vllm-production-deployment-guide-2026/).

## 3. Company system prompt editable in Veil Console

Split the prompt into two layers:

- **Base protected prompt** — ours. Stays compiled into the Veil binary
  (`internal/prompts/prompts.go`). It encodes harness behavior (tools, playbook
  framing, safety) that we tune alongside the runner; customers editing it would
  break the product we are responsible for. It updates when we ship a Veil
  release — that is fine at a slow cadence.
- **Company overlay** — theirs. A Console-edited text block (tone, internal
  terminology, company policies, "who we are") appended to the protected prefix
  on every request. Stored in `console.db`, handed to Veil as a file path
  (`VEIL_COMPANY_PROMPT_PATH`, written under `/var/lib/veil-console` so the
  unit's `ReadWritePaths` already covers it), applied via the existing
  supervisor restart flow. Byte-capped, audit-logged on every edit.

This gives customers real customization without giving them the keys to the
harness contract, and it means "give them a new binary for the system prompt"
is only ever needed for *our* base prompt.

## 4. Buckets and playbooks in Console: recommendation — no

Buckets/playbooks are harness tuning, tightly coupled to the runner loop and
tool behavior. They should keep shipping inside the Veil binary, updated when we
update the harness. From a customer standpoint the customization need is already
covered by the company overlay prompt and RAG.

The tolerant `harness_bucket` contract (hints, not enums) leaves the door open:
if a customer case ever demands it, Console could let admins map **additional**
company-defined hints to company playbooks — additions only, never edits to
ours. Deferred until a real customer asks.

## 5. Telemetry browsing and export on the server

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
  feedback ratings, RAG hit/skip rates from §1's counters). Because the
  telemetry vocabulary is open, events added by newer harnesses are already in
  the stored bundles before the dashboard knows how to chart them — a Console
  update can visualize data retroactively.

## 6. Prerequisites and supporting work

- **`console.db` migrations** (blocks §1 milestone 1): replace the destructive
  `migrateConfigurations` (`internal/state/state.go` — any unexpected shape
  ends in `DROP TABLE configurations`, discarding the admin's saved config)
  with an additive mechanism: a `schema_version` table and forward-only,
  idempotent steps that never drop user data. Required for the RAG, prompt,
  and telemetry tables.
- **Installer upgrade fix**: `install.sh` overwrites binaries but only runs
  `systemctl enable --now`, which does **not** restart an already-running
  service — a re-run leaves the old process on the old binaries. Add
  `systemctl restart` on upgrade plus a version stamp in
  `/opt/umbratic/veil-console`. Needed before release zips (now carrying
  Qdrant) become the routine update path.
- **Template registry activation**: Console never sets
  `VEIL_TEMPLATE_REGISTRY_PATH` (it is absent from the supervisor's allowlisted
  child environment), so the registry is unreachable on every Console-supervised
  deployment today. Wire it through and add the Console management UI — it is
  the general "push versioned content to Veil without recompiling" channel and
  the delivery mechanism for the overlay file in §3.
- **Feature names**: each feature ships a capability name (`rag`,
  `company-prompt`, `telemetry-export`) in `/api/health` so desktops can gate
  UI; mirror new names in `apps/desktop/src/main/veilFeatures.ts`.
- **`docs/storage-layout.md`**: write it (README links to it; it does not
  exist). Server paths gain `/var/lib/veil-console/documents/`,
  `/var/lib/qdrant/`, `/etc/qdrant/config.yaml`, and the qdrant-api-key file.
- **Parked**: installer signing/notarization and desktop auto-update
  (electron-updater over GitHub Releases). Not scheduled; blocked on signing
  certificates, not on design.
