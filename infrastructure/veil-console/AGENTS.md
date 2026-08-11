# AGENTS.md

## Veil Console

Veil Console is a separate Go service. Development runs natively on Windows, macOS, and Linux. The production release target is Ubuntu 24.04 LTS on `amd64`. Console owns administrator authentication, local configuration state, secrets, and the lifecycle of one Veil child process. It serves only embedded server-rendered pages on a loopback address.

Do not merge Console code into Veil. Console can change Veil only through its fixed executable path, an allowlisted child environment, and Veil's authenticated HTTP API. Console must set `VEIL_ENV_FILE=-` and must not inherit the parent environment.

## Security Boundaries

- Accept only `127.0.0.1` or `::1` as the Console listen address. Do not add an override.
- For an HTTPS reverse proxy, accept only one validated exact HTTPS origin. Keep the Console listener on loopback and mark authentication cookies as `Secure`.
- Do not add a shell, command runner, generic environment editor, file browser, public listener, or browser-supplied executable arguments.
- **One deliberate exception: the managed-model launcher.** Console starts `vllm serve` for each registered model, and an administrator edits that model's argument list on the Models page. The box looks like a command line and is not one: the text is tokenized into argv and the vLLM binary is executed directly, so no shell exists at any point. `;`, `|`, `&`, `<`, `>`, `$`, and backticks are refused outright — not because they would be interpreted, but so that they never can be. Quotes group a token and do nothing else. The child gets an allowlisted environment (PATH/HOME/CUDA/HF), never the parent's. See `internal/config/models.go` for the parser and `internal/supervisor/models.go` for the launch.
- **What that exception costs, stated plainly.** Whoever holds an administrator session chooses which flags vLLM runs with, and some flags are dangerous on their own — `--trust-remote-code` executes code from the model repository. This is accepted because Console is a loopback admin surface for an operator who already controls the machine. Do not extend it: no shell, no second binary, no environment editor.
- Store passwords as versioned Argon2id verifiers. Store session and setup tokens only as hashes.
- Put non-secret state in SQLite. Put only the Veil token and CSRF signing key in the restricted secret file.
- Support only local Ollama or local vLLM runtimes without provider authentication.
- Keep secrets out of URLs, logs, audit rows, database configuration rows, templates, and errors. A new Veil token can appear once in a no-store authenticated response.
- Validate Host, Origin, CSRF, method, content type, and body size for every state change.
- Validate the resolved and connected provider IP. Permit only loopback or private addresses. Reject link-local and cloud metadata addresses.
- Start Veil without a shell and with a complete allowlisted environment.
- Serialize all start, stop, restart, apply, and token rotation operations.

## Structure

- `cmd/veil-console` parses fixed startup options and owns shutdown.
- `cmd/bundle-zip` creates deterministic release archives with the Go standard library.
- `internal/auth` owns password and opaque-token primitives.
- `internal/config` owns typed Console and Veil configuration validation.
- `internal/state` owns SQLite schema initialization, accounts, sessions, configurations, audit events, and the secret file.
- `internal/supervisor` owns provider tests, Veil process state, health checks, rollback, and the per-model vLLM child processes.
- `internal/web` owns routes, middleware, embedded templates, and assets. Keep business rules outside handlers.

## Dependencies

Direct dependencies are pinned in `go.mod` and explained in `README.md`. Keep SQLite and Argon2id behind their local packages. Do not add a web framework, frontend framework, ORM, Node runtime, plugin system, or message bus.

## Verification

Run from this directory:

```sh
gofmt -w <changed-go-files>
go test -race ./...
go vet ./...
```

Run from the repository root before completion:

```sh
npm run supply-chain:check
npm run test:all
```
