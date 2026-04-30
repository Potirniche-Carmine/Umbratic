---
tags: [packaging, on-premise, vllm, ollama, llama-cpp, deployment, vpn, gateway, april-2026]
status: draft
---

# LLM Packaging — server bundle + local trial

The hardest part of an on-premise agent stack is *not* training the model and *not* writing the harness — it's **shipping a working bundle to a customer's GPU server, having it stay up, and having the developer laptops talk to it through a corporate network**. This article catalogs the choices for both ends of that pipeline:

- **Server bundle** — what runs on the GPU box (model server, gateway, observability, persistence).
- **Local 7 B trial** — how a single developer can run the whole stack on their laptop with a smaller model before any GPU spend, useful for proofs-of-concept and for offline degraded mode.
- **The link** — VPN, mTLS, WebSocket — that connects laptop to server through a corporate firewall.

Backlinks: [[Index]], [[Sovereign_Coding_Agent]], [[Harness_Implementation_Plan]], [[Small_Models_2026]], [[Tooling_Benefits]], [[Codex_App]], [[Hermes]]

---

## The server bundle — what to package

For a [[Sovereign_Coding_Agent|Sovereign-Coding-Agent-shaped]] deployment ([[Sovereign_Coding_Agent#3. System Topology]]), the GPU server runs:

```
┌──────── Customer GPU server (e.g. RTX PRO 6000 96 GB) ────────┐
│                                                                │
│  Edge Gateway:  Envoy AI Gateway   (TLS 1.3 + mTLS + JWT)      │
│       │                                                         │
│       ▼                                                         │
│  Orchestrator: companycode-orchestrator (Rust, axum)           │
│       │                                                         │
│       ├─► vLLM:  Manager (Qwen3.6-27B FP8)                     │
│       ├─► vLLM:  Worker  (Qwen3-Coder-7B FP8)                  │
│       ├─► Embedding service:  jina-embeddings-v3               │
│       ├─► Reranker service:   BGE-reranker-v2-m3               │
│       ├─► Qdrant:  shared knowledge index (read-only)          │
│       └─► Postgres: preference DB for DPO                      │
│                                                                │
│  Observability:  Prometheus + Loki + Grafana + OTel/Tempo      │
│  Process supervision: systemd or k3s                            │
└────────────────────────────────────────────────────────────────┘
```

### Inference engine — pick **vLLM**, not Ollama or llama.cpp

The 2026 consensus is unambiguous for **multi-tenant production serving**:

| Engine | Best for | Throughput at 50 concurrent | p99 latency at 50 concurrent |
|---|---|---|---|
| **vLLM** | Production multi-user serving | **~6× Ollama** | **<3 s** |
| **Ollama** | Single-user laptop, dev | Baseline | ~24.7 s |
| **llama.cpp** | Edge / portable / CPU-only | Single-stream, very low overhead | n/a |

vLLM owns multi-tenant serving because of three named features no other engine gives you simultaneously:

1. **PagedAttention** — KV cache managed in pages, like virtual memory. Reduces memory consumption 19–27 % vs naïve allocation; ~95 % effective utilization of GPU memory for the cache, which is what *limits concurrency* at long context.
2. **Continuous (rolling) batching** — new requests join the active batch the moment a slot frees up. ~5–10× throughput vs. naïve serving. Iteration-level scheduling absorbs latency variance between requests.
3. **Automatic prefix caching** — system prompt + tool schemas + repo card are identical across most requests. vLLM detects shared prefixes and reuses their KV cache. For the Sovereign Coding Agent's prompt shape (stable L0–L5 prefix per [[Sovereign_Coding_Agent#6.1 Context Layers (Manager target ≈ 24 K tokens)|§6.1]]) this is a 30–50 % latency cut on repeat structures.

Plus **multi-LoRA serving** (one base 27 B in VRAM; hot-swap per-team LoRA adapters at request time — that's how DPO fine-tunes ship without redeploy) and **MTP speculative decoding** (vLLM has a Qwen 3.6 recipe; ~1.5–2× decode throughput).

### Production vLLM serve flags

```bash
vllm serve Qwen/Qwen3.6-27B-FP8 \
  --tensor-parallel-size 1 \
  --max-model-len 65536 \
  --gpu-memory-utilization 0.92 \
  --enable-prefix-caching \
  --reasoning-parser qwen3 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":2}' \
  --max-num-seqs 8 \
  --enable-lora \
  --max-loras 4 \
  --max-lora-rank 32
```

`--max-num-seqs 8` means up to 8 concurrent generations on the Manager — sufficient for 10 devs at peak per [[Sovereign_Coding_Agent#5.5 Sizing & Linear Scaling|§5.5]].

### Containerize — Docker first, Kubernetes when you need to

**Phase 1 (10 devs, 1 GPU box): Docker Compose.** A single `docker-compose.yml` with five services — vLLM Manager, vLLM Worker, embed, rerank, orchestrator — is enough. Use the official `vllm/vllm-openai` image (packages everything: vLLM, deps, OpenAI-compatible server). PersistentVolumes for model weights (`~/.cache/huggingface`) and KV-cache spill.

```yaml
# excerpt
services:
  vllm-manager:
    image: vllm/vllm-openai:v0.10.x
    runtime: nvidia
    deploy: { resources: { reservations: { devices: [...] } } }
    volumes:
      - ${HF_HOME}:/root/.cache/huggingface
      - vllm-prefix-cache:/var/vllm/prefix
    command: >
      --model Qwen/Qwen3.6-27B-FP8
      --max-model-len 65536
      --enable-prefix-caching
      --enable-lora
      --max-num-seqs 8
    ports: ["8000:8000"]
```

**Phase 2 (20+ devs): Kubernetes via the [vLLM Production Stack](https://github.com/vllm-project/production-stack).** It's the reference K8s-native cluster-wide deployment: HPA on KV-cache pressure, prefix-cache-aware routing, GPU device plugin. NVIDIA's Kubernetes Device Plugin handles the GPU side; PVCs hold the model cache.

**Don't go straight to K8s for 10 devs.** A `docker compose up` is operationally honest at that scale. The K8s tax shows up as: TLS cert lifecycle, secret rotation, ingress weirdness, and 2 AM alerts about pod evictions, none of which buy anything until you have ≥3 GPU nodes.

### Edge gateway — Envoy AI Gateway

[Envoy AI Gateway](https://aigateway.envoyproxy.io/) is the on-premise standard for putting an LLM behind enterprise auth + rate limiting + audit. Built on Envoy Proxy, AGPL-licensed reasonable, K8s-native, and **understands LLM traffic** (not just HTTP) — meaning it can rate-limit on tokens, apply per-tenant quotas, and route by model.

For the Sovereign Coding Agent:

- **Tier 1:** the Envoy AI Gateway terminates TLS 1.3 + mTLS, validates the developer's JWT (OIDC SSO), checks source IP allowlist.
- **Tier 2:** routes to the orchestrator (which itself routes Manager vs Worker per [[Sovereign_Coding_Agent#5.6 Routing Policy|§5.6]]).

This is the [two-tier gateway pattern Envoy ships](https://aigateway.envoyproxy.io/docs/) for self-hosted model clusters. It's the cleanest way to satisfy a security team's "all LLM traffic flows through one auditable choke point" requirement.

LiteLLM is the cloud alternative. For on-premise, Envoy is closer to the customer's existing infra.

### Persistence

| Need | Choice | Why |
|---|---|---|
| Preference DB (DPO data) | Postgres | Standard, queryable, easy to back up |
| Shared knowledge index | Qdrant (read-only) | Excellent filtered search; isolated from per-project laptop indices |
| Per-project vector DB | LanceDB **on the laptop** | Per [[Sovereign_Coding_Agent#7. Vector Database — Bundled, Invisible\|§7]] |
| Cold archive | S3-compatible (MinIO on-prem) | Logs, old preference data |
| KV-cache spill | Local NVMe (4 TB) | vLLM spills past GPU mem |

### Observability

Prometheus (metrics) + Loki (logs) + Grafana (dashboards) + OTel/Tempo (traces). All open source, all common enough that a customer's ops team has run them. Per-tier metrics: TTFT, decode tok/s, KV-cache utilization, prefix-cache hit rate, queue depth, GPU memory used. Trace IDs surfaced in the Sovereign Coding Agent client UI on error so devs link a bug report directly to a trace ([[Harness_Design_Principles#Production patterns]]).

---

## The link — connecting laptop to server through a corporate network

This is the actual operational pain point. Three patterns work in 2026:

### Pattern A — corporate VPN (most enterprises)

Customer already has a VPN (Cisco AnyConnect, Tailscale Enterprise, WireGuard, OpenVPN). Developer laptops are on the VPN; the GPU server is on an internal subnet only reachable through the VPN. The Sovereign Coding Agent daemon does:

```
Laptop on VPN ──► internal DNS ──► gpu-server.internal:443 ──► Envoy AI Gateway ──► Orchestrator
                                  (TLS 1.3 + mTLS, WSS)
```

This is the Sovereign Coding Agent default. It's also how [[Codex_App|Codex]] enterprise deployments work and how Cursor Enterprise's BYOC option works.

**Pros:** customer's existing security tooling (NAC, posture checks, audit) covers the agent's traffic for free. No new auth surface.
**Cons:** VPN must be up. WSS over VPN-over-TLS works but DPI-aware corporate VPNs sometimes break long-lived WS connections — that's why [[Sovereign_Coding_Agent#4.2 Wire Protocol|§4.2]] mandates 25 s ping / 60 s timeout / `resume_token`.

### Pattern B — Tailscale / WireGuard mesh (smaller teams, modern stacks)

[Tailscale](https://tailscale.com/) on every laptop and on the GPU server. Tailscale ACLs grant the laptop's identity access to the server; mTLS-on-top-of-Tailscale is belt-and-braces. This is the cleanest setup for ≤25-developer customers without an existing enterprise VPN. Open-source self-hosted Tailscale is [Headscale](https://github.com/juanfont/headscale).

**Pros:** zero-config from the user perspective; SSO-aware; works through hostile NAT.
**Cons:** sells a "we depend on Tailscale" story; some enterprise security teams won't accept a third-party control plane (Headscale fixes this).

### Pattern C — public ingress with mTLS + JWT (smallest customers, public cloud-hosted)

GPU server has a public ingress (with allowlisted source IPs); laptop connects directly with mTLS + JWT. Same wire shape as Pattern A, no VPN.

**Pros:** simple.
**Cons:** every customer security team will push back. Avoid unless explicitly asked.

### The actual wire — WebSocket, not gRPC, not HTTP/2-streaming

Per [[Sovereign_Coding_Agent#4.1 Why WebSocket (not gRPC, not raw HTTP)|§4.1]]:

- Bidirectional streaming and multiplexed via per-request IDs.
- Traverses corporate TLS-inspecting proxies as TLS 443.
- Debuggable in browser DevTools (the renderer can pop one open against the daemon).
- Native fit for Electron's renderer-side `WebSocket` API.

gRPC is faster on the wire but harder to operate through corporate TLS-inspecting proxies (gRPC over HTTP/2 frequently gets mauled by middleboxes that "support" HTTP/2 but mangle long streams). HTTP/2 raw streaming has the same problem.

The Sovereign Coding Agent's framing choice (JSON-lines for control, MessagePack opt-in for binary embeddings) is the right shape. **One gotcha to remember:** intermediate proxies often buffer responses. Set `X-Accel-Buffering: no` on every WS upgrade and the server side flushes per chunk.

### Why an "open socket like other harnesses do" works

The pattern every modern harness uses is the same:

| Harness | Local IPC | Remote IPC |
|---|---|---|
| Codex | stdio JSON-RPC (renderer ↔ `codex-app-server`) | OpenAI HTTPS |
| Hermes | stdio JSON-RPC (ACP) | model-provider HTTPS |
| Cursor | IPC + custom proxies | Anysphere HTTPS |
| **Sovereign Coding Agent** | **localhost WSS** (renderer ↔ daemon) | **WSS + mTLS** (daemon ↔ orchestrator) |

The Sovereign Coding Agent's daemon plays the role of "thing that holds the long socket open" so the renderer doesn't have to. This is how WS drops, Wi-Fi flips, and laptop sleep don't kill an in-progress task — the renderer just reconnects to the daemon, the daemon resumes the upstream stream, and the partial state is preserved via `resume_token`.

---

## The local 7 B trial — single-laptop POC

Before any GPU spend, you want to demo the Sovereign Coding Agent's full architecture on a developer laptop. The whole agent loop, just with a smaller model. This is what proves the harness before the customer signs anything.

### Hardware floor

| Hardware | What runs | Comfortable? |
|---|---|---|
| Apple M3 Pro / M4, 36 GB | Qwen3-Coder-7B Q4 via MLX, full daemon | Yes |
| RTX 4090 24 GB | Qwen3-Coder-7B FP8 via vLLM, full daemon | Yes |
| RTX 4070 12 GB | Qwen3-Coder-7B Q4 via Ollama, full daemon | Tight |
| Intel Mac / older | llama.cpp Q4, smaller model only | Slow but works |

**Sweet spot: any 24 GB+ Apple Silicon Mac or 4090.** A 7 B model at Q4 fits in ~5 GB; you have plenty of headroom for the daemon, LanceDB, and a debugger session.

### Inference engine — pick **Ollama** for the trial

For a single-user laptop:

- **Ollama:** wraps llama.cpp, ships as a service, manages model downloads, exposes an OpenAI-compatible HTTP API on `localhost:11434`. **The premier choice for rapid prototyping**; on a single-user workload it actually beats vLLM on TTFT because there's no batching overhead.
- **llama.cpp** directly: more flexible, smaller binary, but you manage the model files yourself.
- **MLX-LM** on Apple Silicon: native Apple frame; the [[Gemma_Chat]] choice. Best perf/watt on M-series.
- **vLLM**: overkill for one user, also doesn't run well on Apple Silicon as of April 2026.

The single-line install:

```bash
brew install ollama          # macOS, works on Linux too via curl|sh
ollama pull qwen3-coder:7b   # pull weights
ollama serve                 # start the local server on :11434
```

The Sovereign Coding Agent's daemon points at `http://localhost:11434/v1` as if it were the orchestrator. Same OpenAI-compatible API, same wire shape — the daemon doesn't need to know it's talking to a local 7 B instead of a remote 27 B.

### Best 7 B-class agent-capable models (April 2026)

| Model | Size | Strength | License | Notes |
|---|---|---|---|---|
| **Qwen3-Coder-7B** | 7 B | Coding + tokenizer aligned with Qwen 3.6-27B | Apache 2.0 | The natural Worker tier ([[Sovereign_Coding_Agent#5.4 Worker Model — Qwen3-Coder-7B\|§5.4]]) |
| **IBM Granite 4.1 8 B** | 8 B | **Best BFCLv3 in size class**; tool calling king; strong RAG | Apache 2.0 | Matches/exceeds prior Granite 4.0-H-Small 32B-A9B MoE on BFCL V3 — the small dense model that beats a larger MoE |
| **Hermes 4 8 B** | 8 B | Function calling + low refusals + neutral alignment | Apache 2.0 | The [[Hermes#Hermes the model family]] entry; SFT'd on the Hermes-Function-Calling dataset |
| **Phi-4-reasoning(+)** | 14 B | Reasoning per-watt champion | MS Research | [[Small_Models_2026#Phi-4-reasoning / Phi-4-reasoning-plus]] — Q4 fits in ~9 GB; great for laptop demos |
| **Gemma 4 E4B** | 4 B (~3 GB) | Apple Silicon native; multimodal | Gemma terms | The [[Gemma_Chat]] default |
| **DeepSeek-R1-Distill-Qwen-7B** | 7 B | Reasoning, math | Apache 2.0 | Older base (Qwen 2.5); good for chain-of-thought, weaker tool calls |

For a Sovereign Coding Agent demo specifically, **Qwen3-Coder-7B** is the right pick because the prompt shape, sampling profiles, and tokenizer carry over directly to the production 27 B Manager. **Granite 4.1 8 B** is the *recommended* trial worker if you want to see [[Small_Models_2026#Implications for the Sovereign Coding Agent|the small-models A/B-test recommendation]] play out — it leads BFCL among 8 B models, which is the workload that matters for the Worker role (tool-output compression, summary, distill).

### What the local trial demonstrates end-to-end

A working POC on one laptop runs the *entire* Sovereign Coding Agent surface against a 7 B model:

1. **Electron UI** — full diff/review interface (Monaco), project list, settings.
2. **Rust daemon** — file watcher, tree-sitter chunker, LanceDB, DAP debugger, shell sandbox, context assembler.
3. **Local model** — Ollama on `localhost:11434` serving Qwen3-Coder-7B.
4. **Tools** — shell, fs, git, LSP, **DAP**, vector search.
5. **Review loop** — comments, manual edits, "send → revise."

What you *don't* get on a 7 B locally:
- Full Manager-Worker split (you'd run two Ollama instances; works but eats RAM).
- Production-grade prefix caching (Ollama's prefix cache is weaker than vLLM's).
- Concurrent sessions (one user only).
- DPO pipeline (no real preference data yet).

But you *do* get the demo that wins a customer meeting: *"here's the same UI, the same agent loop, the same DAP debugger, running entirely offline on my laptop. Now imagine this with a 27 B Manager on your GPU server."*

### Degraded-mode "laptop fallback" for production

A real Sovereign Coding Agent deployment can ship the local-7 B path as a *degraded mode*: when the GPU server is unreachable (VPN dropped, network outage, working from a plane), the daemon transparently falls over to a local Qwen3-Coder-7B or Phi-4-reasoning. Quality drops, but the agent still works. This is the [[Small_Models_2026#Implications for the Sovereign Coding Agent|"Phi-4 as edge fallback" recommendation]] from the small-models note made concrete — and it's a feature no cloud-hosted competitor can match.

---

## Putting it together — a deployable bundle

The packaging story for a customer install:

1. **Server side:** a tarball with `docker-compose.yml`, three Dockerfiles (orchestrator, embedder, reranker), a `models/` directory with `Qwen3.6-27B-FP8` and `Qwen3-Coder-7B-FP8` (~38 GB total), an Envoy config, a Grafana dashboard JSON. Deploy = `docker compose up -d`. Day-2 ops = `docker compose pull && docker compose up -d`.
2. **Laptop side:** a signed Electron installer (one per OS), embedding the Rust daemon binary. First launch: SSO prompt → mTLS cert provisioning from the gateway's per-laptop CA → `Add Project`. The first project indexes against the local LanceDB; nothing leaves the laptop except embed requests.
3. **Network:** customer's existing VPN. mTLS + JWT layered on top.
4. **Local trial:** a *separate* installer flag `--local` that swaps the orchestrator URL for `localhost:11434` and bundles an Ollama install + one model pull. Same UI, same daemon — just no server.

Everything else (DPO retraining, observability, preference DB, shared knowledge index ingest) is server-side and ops-team-driven, not in the developer's path.

---

## Open questions

- **Model weights distribution.** Customer behind an air-gapped network can't `huggingface-cli download`. Need an offline weights-bundle workflow — probably a signed tarball mirrored to the customer's internal artifact registry.
- **vLLM upgrade cadence.** vLLM moves fast (multiple breaking releases per quarter). The bundle's vLLM version needs to be pinned and tested against the chosen Qwen 3.6 recipe; bumping it casually breaks prefix caching at minimum.
- **Tailscale acceptance.** For customers without an existing VPN, Tailscale (or self-hosted Headscale) is by far the smoothest path. Some security teams refuse it. Document the Headscale option for those.
- **Local trial → production migration.** When a customer goes from "tried it on my laptop" to "deployed on the GPU box," do they keep their local LanceDB index? Yes — per [[Sovereign_Coding_Agent#7. Vector Database — Bundled, Invisible|§7]] the index is the laptop's regardless of what serves the model.

---

## Sources

### Inference engines
- [vLLM (vllm-project/vllm)](https://github.com/vllm-project/vllm)
- [vLLM Automatic Prefix Caching docs](https://docs.vllm.ai/en/stable/design/prefix_caching/)
- [vLLM Optimization and Tuning](https://docs.vllm.ai/en/stable/configuration/optimization/)
- [Inside vLLM: Anatomy of a High-Throughput LLM Inference System — Aleksa Gordić](https://www.aleksagordic.com/blog/vllm)
- [vLLM Production Stack (K8s reference)](https://github.com/vllm-project/production-stack)
- [Deploying vLLM with Docker — Juan C Olamendy](https://medium.com/@juanc.olamendy/deploying-vllm-with-docker-the-complete-guide-to-production-ready-llm-inference-39b812c01535)
- [Ollama vs vLLM Performance Benchmark 2026 — SitePoint](https://www.sitepoint.com/ollama-vs-vllm-performance-benchmark-2026/)
- [llama.cpp vs Ollama vs vLLM — Decodes Future](https://www.decodesfuture.com/articles/llama-cpp-vs-ollama-vs-vllm-local-llm-stack-guide)
- [vLLM or llama.cpp — Red Hat Developer](https://developers.redhat.com/articles/2025/09/30/vllm-or-llamacpp-choosing-right-llm-inference-engine-your-use-case)
- [Self-Hosted LLM Guide 2026 — premai](https://blog.premai.io/self-hosted-llm-guide-setup-tools-cost-comparison-2026/)
- [Best Ollama Models 2026 — Morph](https://www.morphllm.com/best-ollama-models)
- [Best Open-Source LLMs Under 7B — MLJourney](https://mljourney.com/best-open-source-llms-under-7b-parameters-run-locally-in-2026/)

### Gateway / VPN / packaging
- [Envoy AI Gateway](https://aigateway.envoyproxy.io/)
- [Envoy AI Gateway docs](https://aigateway.envoyproxy.io/docs/)
- [LLM Gateway On-Premise Infrastructure — TrueFoundry](https://www.truefoundry.com/blog/llm-gateway-on-premise-infrastructure)
- [Best LiteLLM Alternatives 2026 — WSO2](https://wso2.com/library/blogs/litellm-alternatives/)
- [Tailscale](https://tailscale.com/)
- [Headscale (self-hosted Tailscale)](https://github.com/juanfont/headscale)

### Models
- [Qwen3-Coder on GitHub](https://github.com/QwenLM/Qwen3-Coder)
- [Qwen3-Coder blog](https://qwenlm.github.io/blog/qwen3-coder/)
- [IBM Granite 4.1 8B on Hugging Face](https://huggingface.co/ibm-granite/granite-4.1-8b)
- [Granite 4.1 LLMs — IBM blog](https://huggingface.co/blog/ibm-granite/granite-4-1)
- [IBM Granite 4.0 announcement](https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models)
- [Hermes 4 — Nous Research](https://hermes4.nousresearch.com/)
- [Phi-4-reasoning Technical Report — arXiv 2504.21318](https://arxiv.org/abs/2504.21318)
- [Gemma 4 — DeepMind](https://deepmind.google/models/gemma/gemma-4/)
