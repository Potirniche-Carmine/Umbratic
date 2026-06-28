# Umbratic Veil

Umbratic Veil is the model boundary for Umbratic. The desktop app calls Veil, and Veil owns auth, prompt injection, route policy, model selection, health checks, and the final call to a private Ollama or vLLM runtime.

## Structure

```text
cmd/veil              server entrypoint
internal/config       .env and server configuration
internal/http         API routes and auth
internal/model        model runtime client and health checks
internal/policy       request validation
internal/prompts      global, route, and runtime-profile prompts
```

In the main Umbratic monorepo, the active desktop app lives at `apps/desktop/`.

## API

All API routes require `Authorization: Bearer <VEIL_AUTH_TOKEN>`.

```text
GET  /api/health
POST /api/engineering/chat
POST /api/marketing/chat
POST /api/sales/chat
```

There is no unauthenticated health endpoint and no generic provider passthrough route.

Engineering requests may include `runtime_profiles` so Veil can add skill-like server guidance only when it is relevant. Supported values are `workspace-toolchain`, `python`, `cmake`, `markdown`, `git`, and `worktree`.

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
```

Use `VEIL_ENV_FILE=/path/to/file.env` only when the env file is not `.env`.

## Network

Use Cloudflare Tunnel to expose Veil to Umbratic when Veil runs on a private server. The tunnel should point to Veil, for example `http://127.0.0.1:8080`, and the Ollama or vLLM runtime should stay private behind Veil.

Do not expose Ollama or vLLM directly. Umbratic only needs the Veil tunnel URL and the bearer token.

## Run

```sh
go run ./cmd/veil
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

Point Umbratic at Veil:

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
