# Current Limits

What Umbratic can serve today, where the hard limits sit, and where the soft
ones start to bite. Numbers marked *default* are configurable; numbers marked
*fixed* are enforced in code. Estimates are labeled as estimates.

## Summary

| Question | Answer |
| --- | --- |
| Users on one server (default settings) | 32 requests generating at once, 4 per user; ~30–150 active users depending on GPU capacity (estimate) |
| Enrolled (mostly idle) users | Up to the license's `max_authorized_users`; enrollment itself is cheap |
| Streaming speed the desktop renders | Comfortable through hundreds of tokens/second; generation hardware is the bottleneck long before the UI (estimate) |
| Longest answer | 8,192 output tokens (default, both modes; Console can raise to 32,768) |
| Context window | 4k–256k selectable, 64k default; bounded by the model and by RAM/VRAM in local mode |
| Largest request body | 64 MB (default) |
| Servers per Console | Exactly one Veil process, one machine. No horizontal scaling. |

## Local mode (one person, one machine)

Local mode runs one `llama-server` sidecar for chat (plus one for dictation
when enabled) behind an app-managed local Veil.

- **One loaded chat model at a time.** Switching models restarts the sidecar.
- **Memory is the real constraint.** The model's weights plus the KV cache for
  the chosen context length must fit in the accelerator's memory (or RAM on
  CPU). The model list already weighs downloads against the machine's memory;
  picking a 256k context on a large model is the usual way to run out.
- **Tokens per second is hardware-bound.** Typical local generation is roughly
  5–60 tokens/second depending on model size, quantization, and GPU (estimate).
  The UI pipeline is not the limit: the main process batches events every
  20 ms and the renderer re-renders streaming markdown at most every 50 ms,
  which stays smooth well past local generation rates.
- **Fixed local caps:** 8,192 max output tokens per answer, 64 MB request
  body, 10 minute model timeout, 12 minute request timeout.
- **No unbounded buffers.** Streamed tool output keeps the last 16 KB per
  command, progress text the last 24 KB, the event feed the last 500 events
  per task, and the renderer caches events for at most 24 tasks. Long sessions
  do not grow renderer memory without bound.

## Server mode (a team on one server)

Veil admits generation work through a fixed-size gate, and everything else is
cheap by comparison.

| Limit | Default | Where set |
| --- | --- | --- |
| Requests generating at once, whole server | 32 | Console → Settings |
| Requests generating at once, per user | 4 | Console → Settings |
| Wait for a slot before "busy" | 30 s | Console → Settings |
| Model requests per user | 120/minute | `VEIL_MODEL_REQUESTS_PER_MINUTE` |
| Max output tokens | 8,192 (UI caps at 32,768) | Console → Settings |
| Max request body | 64 MB (up to 256 MB) | Console → Settings |
| Model / request timeout | 60 s / 75 s | Console → Settings |
| Authorized users and devices per user | per license | Signed entitlement |

What that means in practice:

- **Concurrency, not headcount, is the limit.** A request only holds a slot
  while a model is generating for it. If an active user generates ~20% of the
  time, 32 slots supports on the order of 150 active users before queueing
  becomes visible (estimate) — but only if the GPU can actually serve 32
  concurrent streams, which for most single-GPU vLLM deployments it cannot.
  In most real deployments the working ceiling is the model server: expect
  the practical "generating at once" number to be what vLLM sustains on the
  card (often 4–16 concurrent streams at usable speed), and size
  `max_concurrent_requests` to match it. Beyond the gate, requests wait up to
  the queue timeout and then get an explicit busy response — they fail
  politely rather than piling up.
- **Each managed model is its own vLLM process** with its own weights and KV
  cache in VRAM. Two models on one card halves what each can serve.
- **One Veil, one machine.** Console supervises exactly one Veil process and
  the vLLM processes beside it. There is no load balancing across servers, no
  failover, and no multi-node story today. If the server is down, every
  desktop in the company is in local mode or offline.
- **Console is single-admin.** One owner account, reachable only over an SSH
  tunnel on loopback. Console state and Veil's identity store are SQLite files
  on that machine — fine at this scale, and a thing to back up.

## Desktop internals worth knowing

- **Storage is SQLite** (`node:sqlite`, synchronous) in the app's data
  directory. It serves one desktop user; there is no shared or multi-user
  desktop state.
- **Tasks run one runner process each.** Parallel work across chats multiplies
  runner processes and their workspaces; dozens of simultaneous tasks on one
  laptop is untested territory.
- **Document previews** read at most 64 MB per file, cache 64 previews, and
  give up after 20 s per file.

## Known gaps (as of this audit)

- **The artifact engine sources are not in the repository.** An over-broad
  `.gitignore` rule (`artifacts/`, now fixed to `/artifacts/`) silently
  excluded `packages/artifacts/` and `apps/desktop/src/main/artifacts/` from
  every commit. A fresh clone does not compile — desktop typecheck, the Cargo
  workspace, and every artifact test fail — until those directories are
  committed from a machine that has them.
- **`go test -race` is not run on Windows** (CGO off). Concurrency changes in
  Veil or Console need a Linux or WSL run.
- **No load testing has been done.** The concurrency numbers above are
  enforced limits and reasoned estimates, not measured saturation points.
  Before selling a seat count, measure: sustained streams per GPU on the
  actual card, and queue behavior at 2× that.
