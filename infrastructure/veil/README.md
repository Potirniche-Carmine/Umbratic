# Umbratic Veil

Umbratic Veil is the model boundary for Umbratic. The desktop app calls Veil, and Veil owns auth, prompt injection, route policy, model selection, health checks, and the final call to a private Ollama or vLLM runtime.

## Structure

```text
cmd/veil              server entrypoint
internal/config       .env and server configuration
internal/http         API routes and auth
internal/model        model runtime client and health checks
internal/policy       request validation
internal/prompts      global, route, and skill-use prompts
```

In the main Umbratic monorepo, the active desktop app lives at `apps/desktop/`.

## API

All API routes require `Authorization: Bearer <VEIL_AUTH_TOKEN>`.

```text
GET  /api/health
POST /api/engineering/chat
POST /api/marketing/chat
POST /api/sales/chat
POST /api/telemetry
```

There is no unauthenticated health endpoint and no generic provider passthrough route.

Chat requests may include a validated `skills` catalog containing only each enabled skill's id, name, description, and source. Veil injects the protected rules that require the model to call `read_skill` and finish reading the relevant local `SKILL.md` before using it. Full skill bodies are never sent in the initial request, and `runtime_profiles` are not supported.

Both desktop modes use this same boundary. Local mode starts a loopback Veil process bundled with the app; Server mode calls a hosted Veil deployment. The runner never injects or forwards a client system prompt in either mode.

The health route checks that the model configured inside Veil is available from the runtime, but it does not return model names or runtime metadata.

## Configure

Veil reads configuration from the process environment and then from an env file.
The env file defaults to `.env` in Veil's working directory; set
`VEIL_ENV_FILE=/path/to/file.env` before starting Veil to use a different file.
Set `VEIL_ENV_FILE=-` to disable env-file loading. Veil Console always uses this
managed mode and supplies a complete allowlisted process environment.
Values already present in the process environment take precedence over values in
the env file. Restart Veil after changing its configuration.

### Required settings

Every deployment must set these three values:

```sh
VEIL_AUTH_TOKEN=replace-with-a-long-random-token
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:11434
VEIL_MODEL=llama3
```

`VEIL_AUTH_TOKEN` authenticates Umbratic clients. `VEIL_PROVIDER_BASE_URL` is the
private Ollama or vLLM address that Veil can reach. `VEIL_MODEL` must exactly match
a model returned by the provider's models endpoint.

### Complete environment reference

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VEIL_AUTH_TOKEN` | Yes | None | Bearer token required by every Veil API route. Use a long, random secret. |
| `VEIL_PROVIDER_BASE_URL` | Yes | None | Base URL of the private model runtime. Keep this runtime inaccessible to public clients. |
| `VEIL_MODEL` | Yes | None | Model ID Veil uses for health checks, connection, and chat. It must exactly match an ID reported by the runtime. |
| `VEIL_ENV_FILE` | No | `.env` | Env file to load. Use `-` to disable env-file loading. This variable must be set in the process environment because it selects the file to read. |
| `VEIL_ADDR` | No | `127.0.0.1:8080` | Address and port on which Veil listens. Keep the default when a local reverse proxy or Cloudflare Tunnel connects over loopback. |
| `VEIL_PROVIDER_PROTOCOL` | No | `vllm` | Provider wire protocol. Supported values are `vllm` and `ollama`. Setting it explicitly is recommended. |
| `VEIL_PROVIDER_CHAT_PATH` | No | Protocol default | Chat endpoint path or full URL. Defaults to `/v1/chat/completions` for vLLM and `/api/chat` for Ollama. |
| `VEIL_PROVIDER_MODELS_PATH` | No | Protocol default | Models endpoint path or full URL. Defaults to `/v1/models` for vLLM and `/api/tags` for Ollama. |
| `VEIL_CONTEXT_LENGTH` | No | `0` | Context window in tokens for Ollama. A positive value is sent as `options.num_ctx`; `0` or unset uses Ollama's default. This setting has no effect for vLLM. |
| `VEIL_MAX_OUTPUT_TOKENS` | No | `8192` | Server-owned maximum generated tokens per response. Veil enforces the smaller of this value and a bounded client request through vLLM `max_tokens` or Ollama `num_predict`. |
| `VEIL_TEMPLATE_REGISTRY_PATH` | No | Empty | Path to the server-owned template registry JSON file. No template metadata is injected when unset. |
| `VEIL_TELEMETRY_ENABLED` | No | `true` | Enables the authenticated `/api/telemetry` ingestion route. Accepted boolean values are `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. |
| `VEIL_TELEMETRY_STORE_PATH` | No | Empty | Directory in which accepted telemetry bundles are persisted. Bundles are validated but not persisted when unset. |
| `VEIL_TELEMETRY_RETENTION_DAYS` | No | `30` | Positive number of days to retain stored telemetry bundles. |
| `VEIL_TELEMETRY_MAX_BODY_BYTES` | No | `16777216` | Positive maximum request-body size for selective telemetry bundles. |
| `VEIL_MODEL_TIMEOUT` | No | `60s` | Timeout for a model-runtime HTTP call. Accepts a Go duration such as `90s` or `2m`, or a bare number of seconds. |
| `VEIL_REQUEST_TIMEOUT` | No | `75s` | Overall timeout applied by Veil to health, connection, and chat operations. Uses the same duration format as `VEIL_MODEL_TIMEOUT`. |
| `VEIL_MAX_BODY_BYTES` | No | `67108864` | Positive maximum request-body size in bytes for bounded multimodal chat requests. Text and decoded image limits are enforced separately. |

`VEIL_PROVIDER_ENDPOINT_PATH` and `VEIL_PROVIDER_MODELS_ENDPOINT_PATH` are legacy
aliases for `VEIL_PROVIDER_CHAT_PATH` and `VEIL_PROVIDER_MODELS_PATH`. The newer
names take precedence when both are set.

Chat policy accepts at most 64 client messages, 256 KiB of encoded text content
per message, and 12 base64 image parts of at most 10 MiB decoded each. The overall
request remains bounded by `VEIL_MAX_BODY_BYTES`.

### Ollama

Start Ollama, make sure the configured model is installed, and use an env file like:

```sh
VEIL_ADDR=127.0.0.1:8080
VEIL_AUTH_TOKEN=replace-with-a-long-random-token

VEIL_PROVIDER_PROTOCOL=ollama
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:11434
VEIL_MODEL=llama3.2
VEIL_CONTEXT_LENGTH=64000
VEIL_MAX_OUTPUT_TOKENS=8192
```

For example, install the model before starting Veil:

```sh
ollama pull llama3.2
```

When `VEIL_CONTEXT_LENGTH` is positive, Veil sends it to Ollama as `num_ctx` when
activating the model and on every chat request. Changing it requires a Veil restart;
Ollama may reload the model with a differently sized KV cache on the next connection
or request. Larger values require more memory and cannot exceed the model/runtime's
supported context. Leave it unset or set it to `0` to use Ollama's default.
Veil sends the effective output allowance as `num_predict` on every chat request.

Veil uses Ollama's `/api/chat`, `/api/tags`, and `/api/generate` endpoints. The
Ollama port should remain private; expose Veil, not Ollama.

### vLLM

Set the context length when starting vLLM, not in Veil. For a 64,000-token context:

```sh
vllm serve your-model --host 127.0.0.1 --port 8000 --max-model-len 64000
```

Then configure Veil to use vLLM's OpenAI-compatible API:

```sh
VEIL_ADDR=127.0.0.1:8080
VEIL_AUTH_TOKEN=replace-with-a-long-random-token

VEIL_PROVIDER_PROTOCOL=vllm
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:8000/v1
VEIL_MODEL=your-model
```

`--max-model-len` limits the combined prompt and output length. If it is omitted,
vLLM derives the value from the model configuration. Current vLLM releases also
accept values such as `64K` and `auto`; consult the
[vLLM serve reference](https://docs.vllm.ai/en/latest/cli/serve/) for the version
installed on the server. Restart vLLM after changing this option.

`VEIL_CONTEXT_LENGTH` is intentionally not forwarded to vLLM, because vLLM sizes
and enforces the context window when the runtime starts. The model must support the
requested length, and the server must have enough KV-cache memory. Do not start
vLLM with `--api-key`. Veil supports only a local model runtime without provider
authentication.

Veil sends the effective output allowance as `max_tokens` on every vLLM chat request.

The vLLM port should remain private; expose Veil, not vLLM.

### Optional templates and telemetry

When `VEIL_TEMPLATE_REGISTRY_PATH` is set, Veil reads a server-owned JSON registry and injects only matching template metadata into protected prompt context. The registry can be either an array or `{ "templates": [...] }` with entries like:

```json
{
  "id": "sales-quarterly-review",
  "kind": "powerpoint",
  "displayName": "Sales Quarterly Review",
  "serverKey": "templates/powerpoint/sales-quarterly-review",
  "version": "2026-06",
  "tags": ["sales", "qbr"],
  "description": "Quarterly sales review deck.",
  "available": true,
  "checksum": "sha256:...",
  "routes": ["sales/chat"]
}
```

`POST /api/telemetry` accepts the desktop app's selective telemetry bundles using the same bearer token as chat. The contract includes compact product events, rated conversations, failed-tool input/response, and context thresholds; it rejects raw top-level task fields and unscoped task-event dumps. It applies `VEIL_TELEMETRY_MAX_BODY_BYTES` and persists accepted JSON bundles under `VEIL_TELEMETRY_STORE_PATH` when that path is set. `VEIL_TELEMETRY_ENABLED=false` disables ingestion by admin policy, while `VEIL_TELEMETRY_RETENTION_DAYS` controls local pruning for stored bundles.

## Network

Use Cloudflare Tunnel to expose Veil to Umbratic when Veil runs on a private server. The tunnel should point to Veil, for example `http://127.0.0.1:8080`, and the Ollama or vLLM runtime should stay private behind Veil.

Do not expose Ollama or vLLM directly. Umbratic only needs the Veil tunnel URL and the bearer token.

## Run

```sh
go run ./cmd/veil
```

From the monorepo root, use the local helper to start the desktop app with the same
connection switching behavior as the packaged app. Local is the first-run default,
and Server remains selectable in Settings:

```sh
npm run local
```

When Local is selected, the desktop app starts and owns the local Veil process, just as the packaged app does. The helper does not read `infrastructure/veil/.env`, and the app does not force Local mode. Users do not configure a Veil URL or token in Local mode. Veil binds to loopback, uses an app-generated transient credential, and starts with telemetry ingestion disabled. Override local runtime values for one run when needed:

```sh
npm run local -- --model llama3.2
npm run local -- --software vllm --base-url http://127.0.0.1:8000/v1 --model your-model
```

## Test

```sh
go test ./...
```

Format Go code when needed:

```sh
go fmt ./...
```

## Umbratic Desktop Settings

Local mode configures the model runtime rather than Veil itself:

```text
Runtime:      Ollama or vLLM
Runtime URL:  http://127.0.0.1:11434
Model:        llama3.2
```

Packaged Umbratic includes the Veil executable and starts it on demand. Server mode instead points Umbratic at an existing Veil deployment:

```text
Server URL:   https://veil.umbratic.ai
Bearer token: VEIL_AUTH_TOKEN
```

Umbratic knows the Veil API routes. It calls `/api/health` to check that Veil can reach its configured model runtime, and picks the chat route from the selected harness profile:

```text
Engineering -> /api/engineering/chat
Marketing   -> /api/marketing/chat
Sales       -> /api/sales/chat
```
