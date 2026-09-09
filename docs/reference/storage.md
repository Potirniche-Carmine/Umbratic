# Storage layout

Every path Umbratic writes, and what a backup needs.

Two rules hold throughout: secrets live in files no other account can read, and
anything regenerable lives outside the directories a backup captures.

## Desktop

One data root per user:

| Platform | Data root |
| --- | --- |
| macOS | `~/Library/Application Support/Umbratic/` |
| Windows | `%LOCALAPPDATA%\Umbratic\` |
| Linux | `$XDG_DATA_HOME/Umbratic/` (default `~/.local/share/Umbratic/`) |

| Path | Contents | Back up |
| --- | --- | --- |
| `state/umbratic.sqlite` | Settings, connection, device identity | Yes |
| `state/chats.sqlite` | Chat history | Yes |
| `state/task-metadata/` | Per-task metadata | Yes |
| `attachments/chats/` | Files attached to chats | Yes |
| `skills/` | Installed skills | Yes |
| `workspaces/scratch/` | Scratch workspaces created for chats | No |
| `worktrees/` | Git worktrees the runner created | No |
| `runtimes/` | Per-workspace runner runtime state | No |
| `artifacts/ocr/` | Rasterized pages cached for OCR | No |
| `cache/models/<model-id>/` | Downloaded GGUF weights, plus `.partial` and `.partial.chunks` while a download is in flight | No |
| `cache/electron/` | Electron session cache | No |
| `logs/electron/`, `logs/runner/`, `logs/crash-dumps/` | Diagnostics | No |
| `telemetry/spool/` | Telemetry bundles waiting to upload | No |

Inside a user's own repository the runner writes `.umbratic/` — build output,
runtime state, diagnostics, temporary files. Workspace-local and disposable.

## Company server

Installed by `deploy.sh` from the target-specific customer ZIP. Mac data lives under `/Library/Application Support/Umbratic/Veil Console/`.

Programs live under `/opt/umbratic/veil-console/`: executables in `bin/`, signed entitlement in `entitlement.json`, deployment settings in `deployment.json`, and pinned runtime dependencies in `runtime/`. Mac also has the installed `venv/` and Python runtime.

Private state lives under `/var/lib/veil-console/` on Linux and `/Library/Application Support/Umbratic/Veil Console/State/` on Mac, owned by `_umbratic`. Back up the entire directory while services are stopped. It includes:

- `console.db`: owner, configuration, sessions, model startup preferences, and document records.
- `secrets.json` and `veil-identity.json`: service credentials, enrolled users, and devices.
- `documents/`: uploaded documents. Mac models live in the adjacent `Models/` directory, writable by local administrators and the service; Linux models remain under state `models/`.
- `qdrant/`, `qdrant.yaml`, and `qdrant-api-key`: vector storage and private database settings.
- `.local/share/caddy/`: TLS certificates and keys. Console reads only the public `root.crt` when creating private-HTTPS enrollment codes.

The private `bootstrap.sock` issues an expiring setup code on request; no setup-code file is written. The installer prints the code only after readiness checks pass.

Console supervises Caddy and generates its `Caddyfile` in the state directory from `connection_settings` in SQLite. System services are `/Library/LaunchDaemons/com.umbratic.{console,qdrant}.plist` on Mac, or `/etc/systemd/system/umbratic-{console,qdrant}.service` on Linux. Deployment creates a stopped-state backup next to the program directory before replacing it.

### Ports

All listeners start on loopback. Caddy becomes reachable over the network after an administrator configures a non-loopback address in Console.

| Port | Service |
| --- | --- |
| 8432 (default) | Caddy HTTPS — the only port desktops reach |
| 8177 | Veil Console — loopback, reach over an SSH tunnel |
| 8080 | Veil — loopback |
| 6333 | Qdrant — loopback |
| 8000 / 8001 | Chat and embedding model runtimes — loopback |

## Why it's like this

The corpus is stored twice on purpose. Originals under
`/var/lib/veil-console/documents/` are the source of truth, so changing the
embedding model re-embeds from them without asking anyone to upload again.
Qdrant holds derived vectors and rebuilds from those originals.

Chunk **text** lives in the Qdrant payload, not in `console.db`. That is what
lets Veil answer a chat request without ever opening the Console database.

Veil writes no configuration file. Console passes every setting through an
allowlisted child environment, so there is no on-disk Veil config to back up or
drift.

Backup and restore steps:
[../guides/operate-server.md](../guides/operate-server.md#back-up).
