# AGENTS.md

## Project Overview

Umbratic Veil is a Go server that sits between Umbratic clients and a private model runtime. The harness should send requests to Veil APIs, and Veil should own prompt injection, model selection, route policy, health checks, and the final runtime call.

## Core Rules

Security and simplicity are the two highest priorities. Keep the model inaccessible unless the request goes through Veil, and prefer the smallest clear implementation over a clever abstraction.

Cloudflare Tunnel is an acceptable transport for exposing Veil to Umbratic. The tunnel should point at Veil, not at Ollama or vLLM directly.

If something can be done clearly in five lines, do it in five lines. Add structure only when it removes real duplication or protects a security boundary.

## Go Code

Use idiomatic Go and the standard library first. Keep handlers small, pass `context.Context`, set timeouts for outbound model calls, and return plain JSON errors without leaking secrets or internal runtime details.

Keep package boundaries boring and obvious:

- `cmd/veil` starts the server.
- `internal/http` owns routes and middleware.
- `internal/model` owns runtime calls.
- `internal/prompts` owns prompt assembly.
- `internal/policy` owns validation and access rules.

## Prompt And API Rules

Prompt logic belongs on the server. Do not put system prompt assembly back into the desktop harness, runner, or client UI.

All routes should use the same basic flow: authenticate the request, validate input, build the global prompt, add the route prompt, call the configured model, and return the response.

Do not create generic runtime passthrough endpoints. Every public API should have a clear purpose such as engineering chat, engineering write, marketing content, or sales support.

## Security

Never log API keys, runtime headers, raw secrets, or full prompt payloads. Redact sensitive values in errors, telemetry, and test fixtures.

Reject oversized requests, unknown routes, unsupported model choices, and any client attempt to override protected system prompts.

## Verification

Run `gofmt` on changed Go files and `go test ./...` when Go code exists. For documentation-only changes, a focused read-through is enough.
