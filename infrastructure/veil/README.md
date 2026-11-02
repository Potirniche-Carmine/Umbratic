# Veil

The Go model gateway used by Umbratic. The desktop manages its own local instance. Run Veil separately for a standalone gateway, or use [Veil Console](../veil-console/README.md) for employee enrollment and managed models.

## Run

Start your private OpenAI-compatible runtime first. For vLLM:

```sh
vllm serve your-model --host 127.0.0.1 --port 8000 --max-model-len 64000
```

Create a private `.env` in this directory:

```sh
VEIL_AUTH_TOKEN=replace-with-a-long-random-token
VEIL_MODE=server
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:8000/v1
VEIL_MODEL=your-model
```

Use the exact model ID served by the runtime. Keep the runtime private and without provider authentication in server mode. For a manually managed llama-server, use `VEIL_MODE=local` and set `VEIL_PROVIDER_API_KEY` to its API key.

```sh
go run ./cmd/veil
```

Veil listens on `127.0.0.1:8080`. Requests use `Authorization: Bearer <VEIL_AUTH_TOKEN>`; `/livez` is unauthenticated. Put HTTPS in front of Veil for remote access. Keep credentials and `.env` out of Git.

Environment values override `.env`. Set `VEIL_ENV_FILE` before startup to choose another file, or `-` to disable loading. Restart after configuration changes. Other settings are defined in [internal/config/config.go](internal/config/config.go).

## Build and test

```sh
go build ./cmd/veil
go test ./...
go vet ./...
```
