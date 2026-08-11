# Veil Console

Veil Console is the local administration service for Veil. It binds only to loopback, stores its state in SQLite, and starts one fixed Veil executable with a complete allowlisted environment.

Development runs natively on Windows, macOS, and Linux. The production release target stays Ubuntu 24.04 LTS on `amd64`. Run the release smoke test on an Ubuntu 24.04 LTS VM or VPS before production use.

## Development

Install Node.js, npm, and Go. Start a private vLLM OpenAI-compatible server that Console can reach. Then run this command from the repository root:

```sh
npm run veil-console:dev
```

The launcher builds native `veil` and `veil-console` binaries and starts Console on `127.0.0.1:8177`.

Pass `--vllm-binary` to let Console launch models from the **Models** tab. It is
validated like the Veil binary: a regular file, not a symlink, not group or
world writable.

Default development state locations:

- Windows: `%LOCALAPPDATA%\Umbratic\Veil Console\dev`
- macOS: `~/Library/Application Support/Umbratic/Veil Console/dev`
- Linux and WSL: `${XDG_STATE_HOME:-~/.local/state}/veil-console`

On Windows, this is a foreground development process. It is not an installed Windows service. The default state directory contains:

- `bin\veil-console.exe` and `bin\veil.exe`
- `console.db`, plus temporary SQLite `-wal` and `-shm` files when the database is open
- `secrets.json`
- `console.lock` while Console runs

To start again with no owner, settings, sessions, or tokens, stop Console with `Ctrl+C`. Then run this PowerShell command:

```powershell
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA "Umbratic\Veil Console\dev") -Recurse -Force
```

The next `npm run veil-console:dev` creates a new state directory and a new one-time setup code. When you use `--state-dir`, remove that selected directory instead.

The default vLLM address is `http://127.0.0.1:8000/v1`. Run Console and vLLM in the same operating system for the simplest setup.

On the first run, the terminal shows a setup URL and a one-time setup code. Keep the command active and open this address in the Windows browser:

```text
http://127.0.0.1:8177/setup
```

Enter the setup code, choose the owner username, and choose a password with at least 15 characters. After login, configure the private vLLM runtime:

- Runtime URL: the private vLLM address that Console can reach.
- Model: the exact model ID reported by the runtime.
- Advanced: one generation profile (temperature, top P, output tokens, reasoning, concurrency).

Veil Console always starts Veil in server mode against vLLM. Local Ollama is managed by the desktop app, not Console.

Veil and Veil Console do not accept a model-provider API key.

Use **Test connection** to verify the selected runtime. **Apply and restart** validates the submitted values, deploys them, and restarts Veil. In a customer release, go to **Access**, create an assigned user, and give that user the one-time Enrollment code.

Stop Console with `Ctrl+C`. The next start uses the saved owner account and last known-good configuration. It also starts Veil again.

## npm commands

Run these commands from the repository root:

```sh
npm run veil-console:dev
npm run veil-console:smoke
npm run veil-console:test
npm run veil-console:release -- --version 0.1.0 --seats 30 --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

- `veil-console:dev` builds and starts Console with persistent native development state.
- `veil-console:smoke` runs the Ubuntu release smoke environment. On Windows, it uses Ubuntu WSL.
- `veil-console:test` runs the normal Console tests as part of `npm run test:all`.
- `veil-console:release` builds one reviewed Ubuntu `amd64` customer installation zip. It requires a positive seat limit and a protected Ed25519 signing key. The device limit defaults to two devices for each assigned user.

To select another development state directory for one start:

```sh
npm run veil-console:dev -- --state-dir ./my-veil-console-state
```

To change the development ports:

```sh
npm run veil-console:dev -- --port 8178 --veil-port 8081
```

`--port` changes the browser port. `--veil-port` changes the private supervised Veil port. Both ports stay on loopback.

## Go dependency integrity

Keep `go.sum` in source control. `go.mod` selects the dependency versions. `go.sum` records trusted content hashes for those modules and lets each Go build reject changed dependency content. The `go build`, `go test`, and release commands use it automatically.

`go.sum` does not run code and does not add a runtime network requirement. A packaged Console on an internet-locked server does not use it. A source build can work without internet only when the required Go modules are already in the local module cache or a reviewed vendor directory.

Console directly uses three reviewed Go modules:

- `golang.org/x/crypto` for Argon2id password verification.
- `modernc.org/sqlite` for the embedded SQLite database.
- `golang.org/x/sys` for a Windows file lock that the operating system releases after a crash.

## Administrator sessions

Console stores only session-token hashes. Login cookies are HTTP-only, strict same-site, secure behind HTTPS, and non-persistent. The server ends a session after 10 minutes without activity or after one hour in total. Active pages send a bounded heartbeat while the administrator is using the page, and the browser submits a secure logout after 10 minutes without interaction. Password confirmation rotates the session token before a sensitive action.

## Expected process model

The administrator browser communicates with Veil Console through loopback, either on the server or through an SSH tunnel. Console reads and writes its SQLite state and restricted secret file. When settings are valid, Console starts the fixed Veil binary with an allowlisted environment in server mode. Veil then communicates with vLLM.

```text
Browser -> native Veil Console :8177 -> supervised Veil :8080 -> vLLM
```

With managed models registered, the last hop fans out: one supervised
`vllm serve` per model, each on its own loopback port. See **Models**.

Console does not expose a shell or a generic environment editor. It does not read a Veil `.env` file. A failed configuration test or failed Veil start keeps or restores the last known-good configuration.

The Overview page shows **Start** when the supervised process is stopped and **Restart** when it is running. Both actions require the owner password. Restart operations are serialized, perform the normal configuration and health checks, and have a five-second server-side cooldown. Console does not define a paused state. If the child process exits, the next page load shows **Start**.

## Models

The **Models** tab is the model fleet. Each entry is one supervised
`vllm serve` process on its own loopback port, and together they are the
registry Console hands Veil as `VEIL_MODELS`.

```text
Browser -> Veil Console :8177 -> supervised Veil :8080 -> vLLM :8001, :8002, ...
```

Start Console with `--vllm-binary /path/to/vllm` to launch models from this
page. Without it the page still lists and edits registered models — Veil routes
to whatever is already running on those ports — but Start is unavailable,
because there is nothing for Console to run.

### The command

Each card carries the argument list its model is started with, editable in
place:

```text
serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8001 --served-model-name qwen3-32b   --max-model-len 32768 --gpu-memory-utilization 0.45 --kv-cache-dtype fp8
```

It reads like a command line and is not one. Console tokenizes it into argv and
executes the vLLM binary directly — there is no shell, so nothing is expanded,
substituted, or chained. `;`, `|`, `&`, `<`, `>`, `$`, and backticks are refused
at the form, so they cannot be stored, let alone run. Quotes group an argument
containing spaces and do nothing else.

### Thinking

There is no control for thinking on this page, deliberately. Thinking is a
chat-template default, and the kwarg that sets it is named differently per model
family — `enable_thinking` for Qwen3 and Gemma 4, `thinking` for Granite 3.2,
DeepSeek-V3.1, and Holo2 — with defaults that go both ways. A checkbox would
have to guess which, so the command says it instead:

```text
--default-chat-template-kwargs '{"enable_thinking": false}'
```

That is the server default for this model. A client may still override it per
request, which is vLLM's own precedence, and is what the desktop's Think toggle
does.

### The rest of the command

The command is the single source of truth. `--port` is where Veil reaches the
model, `--max-model-len` is the window Veil publishes, and both are read back
out of the command rather than stored a second time and allowed to drift.
`--port` and `--served-model-name` are therefore required, and the served name
must keep matching the model's id — clients already use that name, so changing
it is a remove and an add. `fp8` is vLLM's 8-bit KV cache and the default here;
there is no literal `q8`.

Because an administrator chooses the flags, an administrator can choose a
dangerous one: `--trust-remote-code` runs code from the model repository. That
is accepted for a loopback console operated by someone who already controls the
machine, and it is the reason this page is not exposed any further.

### Lifecycle

**Save** stores the command; it does not touch a running process. A model
already serving keeps running exactly as it was launched, and the card says
`Saved. Restart to run this command.` until it does. **Restart** stops and
starts from the saved command. **Start** returns immediately and the row reports
`Starting` until the runtime lists its own served id — loading weights takes
minutes, so a blocking start would time out the browser long before the model
was ready. Expand **Output** for the tail of that process's log, redacted the
same way Veil's is.

**Start and stop do not restart Veil.** Availability is live on Veil's
`/api/models`, so a model that comes up is usable immediately. Adding, editing,
or removing a model changes the registry, and the page says so: restart Veil
from Overview to apply it. Console signals each model's whole process group on
shutdown, so no worker outlives the Console that started it.

Registered models also become the **Default model** choices on Settings. The
default has to be one of them: a default naming anything else would point Veil
at a process nobody starts.

The Models page asks for the owner password nowhere. Console is a loopback
surface behind a session, and re-confirming a password on every click bought
nothing here.

## Documents and retrieval

The **Documents** tab holds the company corpus. An administrator uploads files
into one of four route sections — Engineering, Sales, Marketing, or All routes —
and the section is the tag that decides who can retrieve them: a request to
`/api/sales/chat` retrieves sales-tagged and all-tagged chunks and nothing else.

Console owns ingestion. It stores the original under
`/var/lib/veil-console/documents/`, extracts text (`.md` and `.txt` directly,
`.docx`/`.pptx`/`.xlsx` with `archive/zip` and `encoding/xml`, `.pdf` by
spawning the bundled `umbratic-pdf`), chunks it, embeds each chunk through the
configured embedding runtime, and upserts the vectors into Qdrant on
`127.0.0.1:6333`. One worker goroutine indexes one document at a time. The type
of an upload is decided by its bytes, never by its file name, and files are
capped at 25 MiB.

Veil owns retrieval. On a chat request it embeds the question, searches the
collection with the route filter, and appends the top chunks with their
citations to the request's untrusted-context block. This is best-effort by
design: if Qdrant or the embedding runtime is down, or the budget is exceeded,
the request is served without retrieval and a counter moves on
`/api/runtime/metrics` (`rag_injected`, `rag_skipped_unavailable`,
`rag_empty_results`). Veil advertises the `rag` feature name on `/api/health`
only while retrieval is enabled.

Retrieval settings reach Veil the same way every other setting does — through
the allowlisted child environment — so saving them restarts Veil. Uploading a
document does not: it is searchable on the next chat request. Changing the
embedding model re-embeds the whole corpus from the stored originals.

```text
Browser -> Console -> extract -> embed -> Qdrant 127.0.0.1:6333
Desktop -> Veil -> embed query -> Qdrant (route filter) -> untrusted overlay -> vLLM
```

For a remote server, keep port `8177` closed and use an SSH tunnel:

```sh
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

See `deploy/veil-console.service` for the reviewed service shape. Replace paths and the service account for the selected Ubuntu host before installation.

> **Do not expose development mode or Veil Console to the public internet.** Veil Console uses loopback. Use an SSH tunnel for remote administration. Do not publish Console or the model runtime through a firewall, NAT rule, cloud security group, or container port map.

## Production network

Veil Console always listens on loopback. It has no public endpoint. Caddy terminates HTTPS for Veil. The desktop application uses this Veil HTTPS address. Caddy blocks the Veil control API, so administrators must use Console through an SSH tunnel. The model runtime also stays private.

```text
Administrator browser -> SSH tunnel -> Veil Console 127.0.0.1:8177

Desktop application
  -> restricted HTTPS Caddy :8432
  -> Veil 127.0.0.1:8080
  -> vLLM 127.0.0.1:8000
```

Allow the Veil HTTPS port only from the company VPN or an exact list of approved desktop IP addresses. Do not expose ports `8177`, `8080`, `11434`, or `8000`.

### Requirements

- Ubuntu 24.04 LTS on `amd64`.
- A DNS record for the Veil domain.
- Caddy installed from its supported Ubuntu package.
- vLLM on a private address.

Build the installation archive from Ubuntu or Ubuntu WSL:

```sh
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-entitlement-signing.key" && chmod 600 "$HOME/umbratic-entitlement-signing.key"
npm run veil-console:release -- --version 0.1.0 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

The zip contains a new organization UID and a signed `entitlement.json`. The same
trusted public key is in the Veil and Console binaries. A local change to the seat,
device, or organization fields makes startup fail.

The zip appears in `artifacts/releases/`. Copy it to `/tmp` on the server,
extract it there, and run:

```sh
cd /tmp
unzip umbratic-veil-console-0.1.0-linux-amd64.zip
cd umbratic-veil-console-0.1.0-linux-amd64
sudo ./install.sh --dnsname veil.example.com
```

The installer puts read-only program files in `/opt/umbratic/veil-console` and
writable service state in `/var/lib/veil-console`. Remove the zip and extracted
directory from `/tmp` after the installation succeeds.

The public HTTPS port defaults to `8432`. To select another public port:

```sh
sudo ./install.sh --dnsname veil.example.com --port 8400
```

The advanced `--console-port` and `--veil-port` options change only the private loopback ports:

```sh
sudo ./install.sh --dnsname veil.example.com --port 8400 --console-port 8177 --veil-port 8080
```

The installer adds the system account, installs the two compiled binaries, writes the systemd and Caddy configuration, validates Caddy, and starts the services. It does not install Ollama, vLLM, or a model because model and hardware requirements differ by server.

Caddy can get a public certificate when the domain has valid DNS and the server can complete certificate validation. A private hostname needs an internal certificate authority. Each desktop device must trust that authority. No safe installer can remove this trust requirement.

Systemd writes the first one-time setup code to a root-protected runtime file:

```sh
sudo cat /run/veil-console/setup-code
```

Start an SSH tunnel from the administrator computer:

```sh
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

Then open:

```text
http://127.0.0.1:8177/setup
```

The setup code expires after 15 minutes and is removed after successful setup. Console stores only its hash. The code proves that the first owner can access the server. Console must not show it on the unauthenticated setup page because a remote visitor could then claim the owner account.

Network rules:

- Permit the selected Veil HTTPS port only from the company VPN or approved desktop IP addresses.
- Permit TCP `80` and `443` when Caddy needs them for public certificate issuance.
- Do not permit remote access to the private Console, raw Veil, or model-runtime ports.
- Keep the model runtime on loopback or another private address.

Do not publish ports `8177`, `8080`, `11434`, or `8000` through a cloud security group, router, container port map, or host firewall. The Caddy route is for desktop product traffic. It returns `404` for `/api/control` and all paths below it.

## Access scope

Veil Console supports one owner account. The owner uses **Access** to assign seats,
issue or revoke Enrollment codes, deactivate or reactivate users, and revoke
devices. End users must not receive Console access.

The customer release works without an Umbratic license service. It does not send
employee identity or license activity to Umbratic. The signed entitlement enforces
the organization, seat, and device limits inside Veil. It does not stop a customer
from copying the complete zip. This redistribution limit is contractual in version
1. A future organization UID heartbeat can add online validation without a change
to the desktop enrollment flow.

For entitlement reissue, key rotation, backup, and recovery steps, see
[`../../docs/enterprise-licensing.md`](../../docs/enterprise-licensing.md).
