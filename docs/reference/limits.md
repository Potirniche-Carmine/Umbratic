# Limits

What one server serves, and where it stops. *Default* means configurable;
*fixed* means enforced in code. Estimates are labelled.

## Summary

| Question | Answer |
| --- | --- |
| Users on one server (defaults) | 32 requests generating at once, 4 per user; ~30–150 active users depending on GPU (estimate) |
| Enrolled but idle users | Up to the licence's `max_authorized_users`. Enrollment is cheap. |
| Longest answer | 8,192 output tokens (default; Console can raise to 32,768) |
| Context window | 4k–256k selectable, 64k default. Bounded by the model, and by RAM/VRAM in local mode. |
| Largest request body | 64 MB (default) |
| Servers per Console | Exactly one Veil process, one machine. No horizontal scaling. |

## Local mode

One `llama-server` sidecar for chat, plus one for dictation when enabled,
behind an app-managed local Veil.

| Limit | Value |
| --- | --- |
| Loaded chat models | One. Switching restarts the sidecar. |
| Max output tokens | 8,192 (fixed) |
| Max request body | 64 MB (fixed) |
| Model timeout | 10 minutes (fixed) |
| Request timeout | 12 minutes (fixed) |
| Generation speed | ~5–60 tokens/second depending on model, quantization, GPU (estimate) |

**Memory is the real constraint.** Weights plus the KV cache for the chosen
context length must fit in the accelerator's memory, or RAM on CPU. Picking a
256k context on a large model is the usual way to run out.

**The UI is not the bottleneck.** The main process batches events every 20 ms
and the renderer redraws streaming markdown at most every 50 ms, which stays
smooth well past local generation rates.

**Nothing grows without bound.** Streamed tool output keeps the last 16 KB per
command, progress text 24 KB, the event feed 500 events per task, and the
renderer caches events for at most 24 tasks.

## Server mode

Veil admits generation work through a fixed-size gate. Everything else is cheap
by comparison.

| Limit | Default | Where set |
| --- | --- | --- |
| Generating at once, whole server | 32 | Console → Settings |
| Generating at once, per user | 4 | Console → Settings |
| Wait for a slot before "busy" | 30 s | Console → Settings |
| Model requests per user | 120/minute | `VEIL_MODEL_REQUESTS_PER_MINUTE` |
| Max output tokens | 8,192 (UI caps at 32,768) | Console → Settings |
| Max request body | 64 MB (up to 256 MB) | Console → Settings |
| Model / request timeout | 60 s / 75 s | Console → Settings |
| Authorized users, devices per user | per licence | Signed entitlement |

**Concurrency is the limit, not headcount.** A request holds a slot only while
a model generates for it. At ~20% duty cycle, 32 slots supports on the order of
150 active users before queueing shows (estimate) — *but only if the GPU can
actually serve 32 concurrent streams, which most single-GPU vLLM deployments
cannot.* Expect the real ceiling to be the model server: often 4–16 concurrent
streams at usable speed. Size `max_concurrent_requests` to what the card
sustains. Past the gate, requests wait out the queue timeout and then get an
explicit busy response rather than piling up.

**Each managed model is its own vLLM process** with its own weights and KV
cache in VRAM. Two models on one card halves what each can serve.

**One Veil, one machine.** No load balancing, no failover, no multi-node story.
If the server is down, every desktop is in local mode or offline.

**Console is single-admin.** One owner account, loopback only, over an SSH
tunnel. Console state and Veil's identity store are SQLite files on that
machine.

## Desktop internals

- Storage is SQLite (`node:sqlite`, synchronous). One desktop user; no shared
  or multi-user desktop state.
- Each task runs one runner process. Dozens of simultaneous tasks on one laptop
  is untested.
- Document previews read at most 64 MB per file, cache 64 previews, give up
  after 20 s per file.

## Known gaps

- **The artifact engine sources are not in the repository.** An over-broad
  `.gitignore` rule (`artifacts/`, now `/artifacts/`) silently excluded
  `packages/artifacts/` and `apps/desktop/src/main/artifacts/` from every
  commit. A fresh clone does not compile until those are committed from a
  machine that has them.
- **`go test -race` does not run on Windows** (CGO off). Concurrency changes in
  Veil or Console need a Linux or WSL run.
- **No load testing has been done.** The numbers above are enforced limits and
  reasoned estimates, not measured saturation points. Before selling a seat
  count, measure sustained streams per GPU on the actual card, and queue
  behaviour at twice that.
