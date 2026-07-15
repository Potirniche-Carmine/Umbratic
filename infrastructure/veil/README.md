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

Create `.env` in the project directory:

```sh
VEIL_ADDR=127.0.0.1:8080
VEIL_AUTH_TOKEN=replace-with-a-long-random-token

VEIL_PROVIDER_PROTOCOL=ollama
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:11434
VEIL_MODEL=llama3
```

For vLLM:

```sh
VEIL_PROVIDER_PROTOCOL=vllm
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:8000/v1
VEIL_MODEL=your-model
```

Optional:

```sh
VEIL_PROVIDER_CHAT_PATH=/v1/chat/completions
VEIL_PROVIDER_MODELS_PATH=/v1/models
VEIL_TEMPLATE_REGISTRY_PATH=/srv/umbratic/templates.json
VEIL_TELEMETRY_ENABLED=true
VEIL_TELEMETRY_STORE_PATH=/srv/umbratic/telemetry
VEIL_TELEMETRY_RETENTION_DAYS=30
```

Use `VEIL_ENV_FILE=/path/to/file.env` only when the env file is not `.env`.

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

`POST /api/telemetry` accepts the desktop app's redacted telemetry bundles using the same bearer token as chat. It rejects raw prompt/task fields, applies the configured request body limit, and persists accepted JSON bundles under `VEIL_TELEMETRY_STORE_PATH` when that path is set. `VEIL_TELEMETRY_ENABLED=false` disables ingestion by admin policy, while `VEIL_TELEMETRY_RETENTION_DAYS` controls local pruning for stored bundles.

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

When Local is selected, the desktop app starts and owns the local Veil process, just as the packaged app does. The helper may read development-only local runtime defaults from `infrastructure/veil/.env`, but the app does not force Local mode and packaged users do not need that file. Users do not configure a Veil URL or token in Local mode. Veil binds to loopback, uses an app-generated transient credential, and starts with telemetry ingestion disabled. Override local runtime values for one run when needed:

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
