# Veil Console

Veil Console is the local administration service for Veil. It binds only to loopback, stores its state in SQLite, and starts one fixed Veil executable with a complete allowlisted environment.

Development runs natively on Windows, macOS, and Linux. The production release target stays Ubuntu 24.04 LTS on `amd64`. Run the release smoke test on an Ubuntu 24.04 LTS VM or VPS before production use.

## Development

Install Node.js, npm, and Go. Start Ollama on the same operating system as Veil Console. Then run this command from the repository root:

```sh
npm run veil-console:dev
```

The launcher builds native `veil` and `veil-console` binaries and starts Console on `127.0.0.1:8177`.

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

The default Ollama address is `http://127.0.0.1:11434`. A native Windows Console connects to Windows Ollama. A native macOS Console connects to macOS Ollama. Run both services in the same operating system for the simplest setup.

On the first run, the terminal shows a setup URL and a one-time setup code. Keep the command active and open this address in the Windows browser:

```text
http://127.0.0.1:8177/setup
```

Enter the setup code, choose the owner username, and choose a password with at least 15 characters. After login, configure one private model runtime:

- Protocol: `Ollama` or `vLLM`.
- Runtime URL: the private runtime address that Console can reach.
- Model: the exact model ID reported by the runtime.

Veil and Veil Console do not accept a model-provider API key. They support only local or private Ollama and vLLM runtimes.

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

The browser communicates only with Veil Console on loopback. Console reads and writes its SQLite state and restricted secret file. When settings are valid, Console starts the fixed Veil binary with an allowlisted environment. Veil then communicates with Ollama or vLLM.

```text
Browser -> native Veil Console :8177 -> supervised Veil :8080 -> Ollama or vLLM
```

Console does not expose a shell or a generic environment editor. It does not read a Veil `.env` file. A failed configuration test or failed Veil start keeps or restores the last known-good configuration.

The Overview page shows **Start** when the supervised process is stopped and **Restart** when it is running. Both actions require the owner password. Restart operations are serialized, perform the normal configuration and health checks, and have a five-second server-side cooldown. Console does not define a paused state. If the child process exits, the next page load shows **Start**.

For a remote server, keep port `8177` closed and use an SSH tunnel:

```sh
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

See `deploy/veil-console.service` for the reviewed service shape. Replace paths and the service account for the selected Ubuntu host before installation.

> **Do not expose development mode or any internal service port to the public internet.** Veil Console is designed to use loopback for its internal listener. A firewall or NAT rule that publishes Console, Veil, Ollama, or vLLM bypasses the intended deployment boundary and creates avoidable risk.

## Production HTTPS

Veil Console always listens on loopback. Caddy terminates HTTPS and forwards requests to Console. Veil and the model runtime also stay private.

```text
Administrator browser
  -> HTTPS Caddy :8432
  -> Veil Console 127.0.0.1:8177
  -> Veil 127.0.0.1:8080
  -> Ollama 127.0.0.1:11434 or vLLM 127.0.0.1:8000
```

Use an administration domain that is available only through a VPN or an IP allowlist when possible. Do not expose ports `8177`, `8080`, `11434`, or `8000`.

### Requirements

- Ubuntu 24.04 LTS on `amd64`.
- A DNS record for the Console domain.
- Caddy installed from its supported Ubuntu package.
- Ollama or vLLM on a private address.

Build the installation archive from Ubuntu or Ubuntu WSL:

```sh
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-entitlement-signing.key" && chmod 600 "$HOME/umbratic-entitlement-signing.key"
npm run veil-console:release -- --version 0.1.0 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

The zip contains a new organization UID and a signed `entitlement.json`. The same
trusted public key is in the Veil and Console binaries. A local change to the seat,
device, organization, or term fields makes startup fail.

The zip appears in `artifacts/releases/`. Copy it to `/tmp` on the server,
extract it there, and run:

```sh
cd /tmp
unzip umbratic-veil-console-0.1.0-linux-amd64.zip
cd umbratic-veil-console-0.1.0-linux-amd64
sudo ./install.sh --dnsname console.example.com
```

The installer puts read-only program files in `/opt/umbratic/veil-console` and
writable service state in `/var/lib/veil-console`. Remove the zip and extracted
directory from `/tmp` after the installation succeeds.

The public HTTPS port defaults to `8432`. To select another public port:

```sh
sudo ./install.sh --dnsname console.example.com --port 8400
```

The advanced `--console-port` and `--veil-port` options change only the private loopback ports:

```sh
sudo ./install.sh --dnsname console.example.com --port 8400 --console-port 8177 --veil-port 8080
```

The installer adds the system account, installs the two compiled binaries, writes the systemd and Caddy configuration, validates Caddy, and starts the services. It does not install Ollama, vLLM, or a model because model and hardware requirements differ by server.

Caddy can get a public certificate when the domain has valid DNS and the server can complete certificate validation. A private hostname needs an internal certificate authority. Each administrator device must trust that authority. No safe installer can remove this trust requirement.

Systemd writes the first one-time setup code to a root-protected runtime file:

```sh
sudo cat /run/veil-console/setup-code
```

Open:

```text
https://console.example.com:8432/setup
```

The setup code expires after 15 minutes and is removed after successful setup. Console stores only its hash. The code proves that the first owner can access the server. Console must not show it on the unauthenticated setup page because a remote visitor could then claim the owner account.

Network rules:

- Permit the selected public HTTPS port only from the administration network when possible.
- Permit TCP `80` and `443` when Caddy needs them for public certificate issuance.
- Do not permit remote access to the private Console, Veil, or model-runtime ports.
- Keep the model runtime on loopback or another private address.

Treat direct public access as an unsupported high-risk deployment. Put the HTTPS administration endpoint behind a VPN or an exact IP allowlist. Do not publish ports `8177`, `8080`, `11434`, or `8000` through a cloud security group, router, container port map, or host firewall.

Console accepts only the exact HTTPS origin supplied to it. HTTPS mode also marks session and CSRF cookies as `Secure`.

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
