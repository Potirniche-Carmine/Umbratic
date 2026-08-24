# AGENTS.md

## Veil Console

Veil Console is a separate Go service. Development runs natively on Windows, macOS, and Linux. The production release target is Ubuntu 24.04 LTS on `amd64`. Console owns administrator authentication, local configuration state, secrets, and process lifecycle: one Veil child, plus one `vllm serve` child per registered model. It serves only embedded server-rendered pages on a loopback address.

Do not merge Console code into Veil. Console can change Veil only through its fixed executable path, an allowlisted child environment, and Veil's authenticated HTTP API. Console must set `VEIL_ENV_FILE=-` and must not inherit the parent environment.

## Security Boundaries

- Accept only `127.0.0.1` or `::1` as the Console listen address. Do not add an override.
- For an HTTPS reverse proxy, accept only one validated exact HTTPS origin. Keep the Console listener on loopback and mark authentication cookies as `Secure`.
- Do not add a shell, command runner, generic environment editor, file browser, public listener, or browser-supplied executable arguments.
- **One deliberate exception: the model command.** An administrator edits each model's vLLM argument list on the Models page. It looks like a command line and is not one — the text is tokenized into argv and the binary is executed directly, so no shell exists at any point, and `;`, `|`, `&`, `<`, `>`, `$` and backticks are refused outright so they never can be. Quotes group a token and nothing more. The child gets an allowlisted environment (PATH/HOME/CUDA/HF), never the parent's. Parser in `internal/config/models.go`, launch in `internal/supervisor/models.go`.
  This means whoever holds an admin session picks the flags, including dangerous ones — `--trust-remote-code` runs code from the model repository. Accepted for a loopback surface operated by someone who already controls the machine. Do not extend it: no shell, no second binary, no environment editor.
- Store passwords as versioned Argon2id verifiers. Store session and setup tokens only as hashes.
- Put non-secret state in SQLite. Put only the Veil token and CSRF signing key in the restricted secret file.
- Support only the local vLLM runtimes Console launches itself, without provider authentication.
- Keep secrets out of URLs, logs, audit rows, database configuration rows, templates, and errors. A new Veil token can appear once in a no-store authenticated response.
- Validate Host, Origin, CSRF, method, content type, and body size for every state change.
- Veil lifecycle and settings changes re-confirm the owner password and rotate the session. Model management deliberately does not: it is session plus CSRF, because asking three times per card bought nothing on a locked local deployment.
- Validate the resolved and connected provider IP. Permit only loopback or private addresses. Reject link-local and cloud metadata addresses.
- Start Veil without a shell and with a complete allowlisted environment.
- Serialize all start, stop, restart, apply, and token rotation operations. Model start and stop are serialized per model.
- Reap every child on shutdown. A model runtime is a process tree, not a process — vLLM's workers inherit its pipes — so signal the whole process group, or `cmd.Wait` never returns and the GPU stays occupied.

## Structure

- `cmd/veil-console` parses fixed startup options and owns shutdown.
- `cmd/bundle-zip` creates deterministic release archives with the Go standard library.
- `cmd/entitlement` signs and inspects customer entitlements.
- `internal/auth` owns password and opaque-token primitives.
- `internal/config` owns typed Console and Veil configuration validation, including each managed model's argument list.
- `internal/state` owns SQLite schema initialization, accounts, sessions, configurations, managed models, documents, audit events, and the secret file. Migrations are forward-only and recorded by name.
- `internal/supervisor` owns provider tests, Veil process state, health checks, rollback, and the per-model vLLM child processes.
- `internal/web` owns routes, middleware, embedded templates, and assets. Keep business rules outside handlers.
- `internal/access` and `internal/entitlement` talk to Veil's control API for users, devices, and enrollment.
- `internal/rag` and `internal/extract` own the document corpus: chunking, embedding, the vector store, and text extraction per file type.
- `internal/localhttp` is the loopback-only HTTP client shared by the above.

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
