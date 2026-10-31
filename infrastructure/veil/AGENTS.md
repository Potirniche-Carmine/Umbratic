# AGENTS.md

## Veil Service

Veil is the Go security and model-policy boundary between Umbratic clients and an admin-configured private model runtime. Electron and the Rust runner send requests to purpose-built Veil APIs; Veil owns authentication, protected prompts, route/model policy, health checks, and the final runtime call.

Cloudflare Tunnel may expose Veil, but it must point to Veil rather than Ollama, vLLM, or another runtime directly.

## Go Structure

Use idiomatic Go and the standard library. Veil intentionally has no third-party Go module dependencies; preserve that unless a dependency has a documented, reviewed need that cannot be met clearly and safely in the standard library.

Keep package boundaries simple:

- `cmd/veil` starts the service.
- `internal/config` loads and validates trusted server configuration, including the `VEIL_MODELS` registry.
- `internal/http` owns routes, authentication, middleware, limits, and response contracts.
- `internal/model` owns outbound private-runtime calls and streaming. One `Client` per registry entry, behind a `Registry` that routes by model id.
- `internal/prompts` owns protected global and route prompt assembly.
- `internal/policy` owns request validation and access rules.
- `internal/identity` and `internal/entitlement` own company identity mode: signed entitlement, users, devices, sessions.
- `internal/rag` owns optional retrieval of company documents into request-scoped untrusted context.
- `internal/templates` owns built-in route/template definitions.

Keep handlers small, pass `context.Context`, enforce timeouts and cancellation on outbound work, and return stable JSON errors without internal details. Add abstractions only when they remove real duplication or protect a trust boundary.

## Prompt And API Rules

Prompt logic belongs on Veil. Do not move protected prompt assembly into the desktop, native core, or runner.

Each public request follows the same security sequence: authenticate, enforce size and shape limits, validate the route and request, build protected global and route guidance, call the configured runtime, and return or stream the response.

Do not create a generic runtime passthrough. Every public endpoint must have a defined product purpose and an explicit policy. Route selection from a client is allowed only within the configured route set; protected system-prompt overrides never are.

A client may name a `model`, but only one this server published. With `VEIL_MODELS` set, `/api/models` lists the registry, `/api/health` advertises `chat.model_selection`, and a body may carry an id from that list. Without it there is no registry, `model` is refused loudly, and the wire behavior is byte identical to a single-model deployment. That refusal is deliberate and must stay: silently answering with a different model than the caller asked for is worse than failing.

## Security

Treat HTTP input and runtime output as untrusted:

- Never log API keys, authorization headers, raw secrets, full prompts, full model responses, or unredacted workspace content.
- Reject missing/invalid authentication, oversized bodies, unknown fields where the contract is strict, unknown routes, models outside the published registry, and client attempts to override protected system guidance. Unknown *vocabulary* on product routes is stripped and counted, never rejected — see the root wire-compatibility rules.
- Keep runtime credentials and model configuration server-side.
- Reasoning content is stripped by default. `stripPrivateReasoning` drops it from vLLM streams and the Ollama `thinking` field is dropped alongside it. A client's `thinking` directive decides whether the model reasons. Forwarding those tokens is a separate opt-in: the client must see `chat.reasoning_visible` on `/api/health` and send `reasoning_visible: true`. Absent or false keeps today's strip.
- Apply server, header, body, stream, idle, and outbound-call timeouts appropriate to each endpoint.
- Preserve backpressure, cancellation, status mapping, and safe error behavior when either side disconnects.
- Do not expose stack traces, runtime addresses, provider bodies, or sensitive configuration in health checks or errors.

## Testing And Verification

Use table-driven tests for authentication, size boundaries, malformed JSON, unknown fields/routes, prompt-override attempts, timeouts, cancellation, upstream failures, stream framing, and redaction. Test handlers with deterministic local HTTP servers; do not require a live model runtime or skip security coverage when one is unavailable. Assert response status, stable error shape, headers, and absence of sensitive values, not merely that a handler returned.

Run:

```sh
gofmt -w <changed-go-files>
go vet ./...
go test -race ./...
npm run test:all
```

Run `npm run test:all` from the repository root even for documentation-only repository changes, as required by the root instructions. `-race` needs CGO, so it is skipped on Windows — run it on Linux or WSL when concurrency changed.
