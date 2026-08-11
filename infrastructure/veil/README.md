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

Veil has two authentication modes.

- Local and development mode use `Authorization: Bearer <VEIL_AUTH_TOKEN>`.
- Company identity mode uses a short device session for product routes and a
  separate Console control token for administration routes. The internal
  `VEIL_AUTH_TOKEN` cannot access product routes in this mode.

```text
GET  /api/health
GET  /api/models
POST /api/engineering/chat
POST /api/marketing/chat
POST /api/sales/chat
POST /api/telemetry

POST /api/enrollment/enroll
POST /api/session/challenge
POST /api/session
POST /api/session/logout

GET  /api/control/access
POST /api/control/users
POST /api/control/users/{user_uid}/deactivate
POST /api/control/users/{user_uid}/reactivate
POST /api/control/users/{user_uid}/enrollment-codes
POST /api/control/enrollment-codes/{code_uid}/revoke
POST /api/control/devices/{device_uid}/revoke
```

Enrollment and challenge requests are public, bounded, and rate limited. All other
routes require the correct authentication class. There is no unauthenticated
health endpoint and no generic provider passthrough route.

Chat requests may include a validated `skills` catalog containing only each enabled skill's id, name, description, and source. Veil injects the protected rules that require the model to call `read_skill` and finish reading the relevant local `SKILL.md` before using it. Full skill bodies are never sent in the initial request, and `runtime_profiles` are not supported.

Both desktop modes use this same boundary. Local mode starts a loopback Veil process bundled with the app; Server mode calls a hosted Veil deployment. The runner never injects or forwards a client system prompt in either mode.

The health route checks that the model configured inside Veil is available from the runtime, but it does not return model names or runtime metadata.

### Model registry

`GET /api/models` lists what this Veil routes to:

```json
{"models":[{"id":"qwen3-32b","display":"Qwen 32B","context_length":98304,
            "capabilities":{"reasoning":true},"available":true,"default":true}]}
```

`available` is live — a registered model whose runtime is stopped stays listed
and unavailable, because a client with it selected needs to see why nothing
answers. Availability is cached for a few seconds, so the picker does not probe
every runtime on the box each time it opens.

Set `VEIL_MODELS` to publish more than one:

```json
[{"id":"qwen3-32b","provider_base_url":"http://127.0.0.1:8001/v1",
  "display":"Qwen 32B","reasoning":true,"context_length":98304},
 {"id":"small","provider_base_url":"http://127.0.0.1:8002/v1"}]
```

`id` and `provider_base_url` are required; ids are unique and at most 256 bytes,
and `VEIL_MODEL` must name one of them. Each entry gets its own frozen endpoint
set at startup, so a chat request naming an id lands on that runtime and nowhere
else.

With `VEIL_MODELS` set, `/api/health` advertises `chat.model_selection` and a
chat body may carry `model`. **Unset, behavior is byte identical to a
single-model deployment**: one synthesized registry entry, no
`chat.model_selection`, and `model` in a chat body is still refused loudly. That
refusal is deliberate — a client that believes it chose a model must never be
answered by a different one.

### Thinking

A chat body may carry `thinking: "on" | "off"`. It is a tolerant hint like
`harness_bucket`: an unreadable value is treated as absent and never refuses the
request. It decides whether the model reasons, never whether that reasoning is
shown — reasoning content stays stripped either way.

- vLLM receives `chat_template_kwargs.enable_thinking`. Only chat templates that
  read it act on it (the Qwen3 family does), so document per-model expectations
  where it matters. `off` also clears `reasoning_effort` and the thinking
  budget, so the request does not ask the model not to think and then tell it
  how hard to think.
- Ollama receives `think`, and only when `api/show` confirms the model carries
  the `thinking` capability: some builds fail the whole request otherwise. A
  failed probe counts as unsupported.

For KV cache precision, vLLM's 8-bit option is `--kv-cache-dtype fp8` — there is
no literal `q8`. A local Ollama administrator sets `OLLAMA_KV_CACHE_TYPE=q8_0`
in the runtime's own environment; Veil does not manage it.

Veil accepts no provider `--api-key`, in this configuration or any other.

## Configure

Veil reads configuration from the process environment and then from an env file.
The env file defaults to `.env` in Veil's working directory; set
`VEIL_ENV_FILE=/path/to/file.env` before starting Veil to use a different file.
Set `VEIL_ENV_FILE=-` to disable env-file loading. Veil Console always uses this
managed mode and supplies a complete allowlisted process environment.
Values already present in the process environment take precedence over values in
the env file. Restart Veil after changing its configuration.

### Required settings

Every deployment must set these values:

```sh
VEIL_AUTH_TOKEN=replace-with-a-long-random-token
VEIL_MODE=local
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:11434
VEIL_MODEL=llama3
```

`VEIL_AUTH_TOKEN` authenticates a local or development client. In company identity
mode it is an internal process credential and cannot access product routes.
`VEIL_MODE` selects the trusted provider adapter once at startup: `server` for vLLM
or `local` for Ollama. `VEIL_PROVIDER_BASE_URL` is the private runtime address that
Veil can reach. `VEIL_MODEL` must exactly match a model returned by the runtime.

### Complete environment reference

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VEIL_AUTH_TOKEN` | Yes | None | Local/development bearer token. In company identity mode, Console supplies a separate internal value that cannot access product routes. |
| `VEIL_MODE` | Yes | None | Trusted runtime mode. `server` uses fixed vLLM endpoints. `local` uses fixed Ollama endpoints. |
| `VEIL_COMPANY_IDENTITY_MODE` | No | `false` | Enables signed entitlement, user, device, and session access control. |
| `VEIL_CONTROL_TOKEN` | In company mode | None | Console-only control credential. It must differ from `VEIL_AUTH_TOKEN`. |
| `VEIL_ENTITLEMENT_PATH` | In company mode | None | Signed customer entitlement file. Veil fails closed if verification fails. |
| `VEIL_IDENTITY_STORE_PATH` | In company mode | None | Customer-managed Veil identity state file. |
| `VEIL_PROVIDER_BASE_URL` | Yes | None | Base URL of the private model runtime. Keep this runtime inaccessible to public clients. |
| `VEIL_MODEL` | Yes | None | Model ID Veil uses for health checks, connection, and chat. It must exactly match an ID reported by the runtime. With `VEIL_MODELS` set it must also name one of that registry's ids, and it is the default a request with no `model` gets. |
| `VEIL_MODELS` | Server | Unset | JSON array of routable models. Unset means the single-model behavior below, byte for byte. |
| `VEIL_ENV_FILE` | No | `.env` | Env file to load. Use `-` to disable env-file loading. This variable must be set in the process environment because it selects the file to read. |
| `VEIL_ADDR` | No | `127.0.0.1:8080` | Address and port on which Veil listens. Keep the default when a local reverse proxy or Cloudflare Tunnel connects over loopback. |
| `VEIL_TRUSTED_PROXY_CIDRS` | No | Empty | Comma-separated addresses or CIDRs whose `X-Forwarded-For` is believed when keying identity rate limits. Leave empty unless the proxy overwrites that header; otherwise a client picks its own bucket. Console sets loopback for the supervised deployment. |
| `VEIL_CONTEXT_LENGTH` | No | `0` | Context window in tokens for local Ollama mode. A positive value is sent as `options.num_ctx`; `0` or unset uses Ollama's default. Unused in server mode. |
| `VEIL_MAX_OUTPUT_TOKENS` | No | `8192` | Server-owned maximum generated tokens per response. Clients may request less, never more. |
| `VEIL_TEMPERATURE` | Server | `0.2` | Sampling temperature from `0.0` to `2.0`. Ignored in local mode, which uses a fixed profile. |
| `VEIL_TOP_P` | Server | `0.95` | Nucleus sampling from greater than `0.0` to `1.0`. Ignored in local mode. |
| `VEIL_REASONING_EFFORT` | Server | `none` | `none`, `low`, `medium`, or `high`. Sent on every vLLM chat request when not `none`. |
| `VEIL_THINKING_TOKEN_BUDGET` | Server | Unset | Optional non-negative thinking token budget no greater than `VEIL_MAX_OUTPUT_TOKENS`. |
| `VEIL_MODEL_PARALLEL_TOOL_CALLS` | Server | `true` | Whether Veil sets `parallel_tool_calls` on vLLM requests that include tools. |
| `VEIL_MAX_CONCURRENT_REQUESTS` | Server / Local profile | `32` / `4` | Global admission semaphore for model work. |
| `VEIL_MAX_CONCURRENT_REQUESTS_PER_USER` | Server / Local profile | `4` / `2` | Per-user admission semaphore when company identity supplies a user. Without identity, only the global bucket applies. |
| `VEIL_QUEUE_TIMEOUT` | Server / Local profile | `30s` | Maximum wait for an admission slot. Exhaustion returns `503` with `code: busy` and `Retry-After`. |
| `VEIL_TEMPLATE_REGISTRY_PATH` | No | Empty | Path to the server-owned template registry JSON file. No template metadata is injected when unset. |
| `VEIL_TELEMETRY_ENABLED` | No | `true` | Enables the authenticated `/api/telemetry` ingestion route. Accepted boolean values are `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. |
| `VEIL_TELEMETRY_STORE_PATH` | No | Empty | Directory in which accepted telemetry bundles are persisted. Bundles are validated but not persisted when unset. |
| `VEIL_TELEMETRY_RETENTION_DAYS` | No | `30` | Positive number of days to retain stored telemetry bundles. |
| `VEIL_TELEMETRY_MAX_BODY_BYTES` | No | `16777216` | Positive maximum request-body size for selective telemetry bundles. |
| `VEIL_MODEL_TIMEOUT` | No | `180s` | Timeout for a model-runtime HTTP call. Accepts a Go duration such as `90s` or `2m`, or a bare number of seconds. |
| `VEIL_REQUEST_TIMEOUT` | No | `195s` | Overall timeout applied by Veil to health, connection, and chat operations after admission. Uses the same duration format as `VEIL_MODEL_TIMEOUT`. |
| `VEIL_STREAM_IDLE_TIMEOUT` | No | `60s` | Maximum idle gap between streamed model chunks. Separate from request and model timeouts. |
| `VEIL_MAX_BODY_BYTES` | No | `67108864` | Positive maximum request-body size in bytes for bounded multimodal chat requests. Text and decoded image limits are enforced separately. |

Chat policy accepts at most 512 client messages, 256 KiB of encoded text content
per message, and 12 base64 image parts of at most 10 MiB decoded each. Tool and
skill payloads are bounded by count and total size but are not schema-checked;
see "Wire Compatibility" in the root `AGENTS.md`. The overall request remains
bounded by `VEIL_MAX_BODY_BYTES`. Clients cannot write system text or name the
model, and generation settings, `tool_choice`, and `parallel_tool_calls` are
Veil's to decide: a client that sends them is ignored, not obeyed.

### Local mode (Ollama)

Start Ollama, make sure the configured model is installed, and use an env file like:

```sh
VEIL_ADDR=127.0.0.1:8080
VEIL_AUTH_TOKEN=replace-with-a-long-random-token

VEIL_MODE=local
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
Veil applies a small fixed local generation profile and sends the effective output
allowance as `num_predict` on every chat request.

Veil uses Ollama's `/api/chat`, `/api/tags`, and `/api/show` endpoints. The
Ollama port should remain private; expose Veil, not Ollama.

### Server mode (vLLM)

Set the context length when starting vLLM, not in Veil. For a 64,000-token context:

```sh
vllm serve your-model --host 127.0.0.1 --port 8000 --max-model-len 64000
```

Then configure Veil to use vLLM's OpenAI-compatible API:

```sh
VEIL_ADDR=127.0.0.1:8080
VEIL_AUTH_TOKEN=replace-with-a-long-random-token

VEIL_MODE=server
VEIL_PROVIDER_BASE_URL=http://127.0.0.1:8000/v1
VEIL_MODEL=your-model
VEIL_TEMPERATURE=0.2
VEIL_TOP_P=0.95
VEIL_MAX_OUTPUT_TOKENS=8192
VEIL_REASONING_EFFORT=none
VEIL_MODEL_PARALLEL_TOOL_CALLS=true
VEIL_MAX_CONCURRENT_REQUESTS=32
VEIL_MAX_CONCURRENT_REQUESTS_PER_USER=4
VEIL_QUEUE_TIMEOUT=30s
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

Veil sends temperature, top_p, max_tokens, optional reasoning settings, and
tool-call controls on every vLLM chat request. Clients cannot override them.

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

`POST /api/telemetry` accepts the desktop app's selective telemetry bundles using the same authentication class as chat. The contract includes compact product events, rated conversations, failed-tool input/response, and context thresholds; it rejects raw top-level task fields and unscoped task-event dumps. It applies `VEIL_TELEMETRY_MAX_BODY_BYTES` and persists accepted JSON bundles under `VEIL_TELEMETRY_STORE_PATH` when that path is set. `VEIL_TELEMETRY_ENABLED=false` disables ingestion by admin policy, while `VEIL_TELEMETRY_RETENTION_DAYS` controls local pruning for stored bundles.

## Network

Use Cloudflare Tunnel to expose Veil to Umbratic when Veil runs on a private server. The tunnel should point to Veil, for example `http://127.0.0.1:8080`, and the Ollama or vLLM runtime should stay private behind Veil.

Do not expose Ollama or vLLM directly. In company identity mode, Umbratic needs
only the Veil URL and a one-time Enrollment code. The desktop does not keep the
Enrollment code after enrollment.

## Run

```sh
go run ./cmd/veil
```

From the monorepo root, build the packaged application to get the same connection
switching behavior end to end. Local is the first-run default, and Company server
remains selectable in Settings:

```sh
npm run desktop:release
```

When Local is selected, the desktop app starts and owns the local Veil process. It
does not read `infrastructure/veil/.env`, and the app does not force Local mode.
Users do not configure a Veil URL or token in Local mode. Veil binds to loopback,
uses an app-generated transient credential, and starts with telemetry ingestion
disabled. Override local runtime values for one run through the environment:

```sh
UMBRATIC_LOCAL_MODEL_ID=llama3.2 npm run desktop:dev
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

Packaged Umbratic includes the Veil executable and starts it on demand. Company
server mode instead points Umbratic at an existing customer Veil deployment:

```text
Server URL:   https://veil.umbratic.ai
Enrollment code: one-time value from Veil Console
```

Umbratic knows the Veil API routes. It calls `/api/health` to check that Veil can reach its configured model runtime, and picks the chat route from the selected harness profile:

```text
Engineering -> /api/engineering/chat
Marketing   -> /api/marketing/chat
Sales       -> /api/sales/chat
```
