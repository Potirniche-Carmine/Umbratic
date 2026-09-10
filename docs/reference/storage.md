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
| `cache/tmp/` | Private temporary files for Electron and its child processes | No |
| `logs/electron/`, `logs/runner/`, `logs/crash-dumps/` | Diagnostics | No |
| `telemetry/spool/` | Telemetry bundles waiting to upload | No |

Inside a user's own repository the runner writes `.umbratic/` — build output,
runtime state, diagnostics, temporary files. Workspace-local and disposable.

## Company server

Installed by `deploy.sh` from the target-specific customer ZIP. Mac data lives under `/Library/Application Support/Umbratic/Veil Console/`.

On Mac, the entire server uses `/Library/Application Support/Umbratic/Veil Console/`:

| Directory | Contents |
| --- | --- |
| `Program/` | Executables, entitlement, deployment settings, pinned dependencies, Python and its virtual environment |
| `State/` | Private settings, credentials, documents, database, logs, caches and temporary files |
| `Models/` | Imported model folders |
| `Backups/<timestamp>/` | Stopped programs and state captured before a deployment |

The installer moves the former `/opt/umbratic/` directory, including its historical backups, into the new deployment backup's `previous-layout/` after readiness succeeds. It rebuilds Python's environment at its new path and updates launchd. Model paths, state and certificates stay in place. If installation fails before readiness, the previous services and state are restored. `--clean` removes active programs, state and models; it retains backup history.

Linux programs remain under `/opt/umbratic/veil-console/`: executables in `bin/`, signed entitlement in `entitlement.json`, deployment settings in `deployment.json`, and pinned runtime dependencies in `runtime/`.

Private state lives under `/var/lib/veil-console/` on Linux and `/Library/Application Support/Umbratic/Veil Console/State/` on Mac, owned by `_umbratic`. Back up the entire directory while services are stopped. It includes:

- `console.db`: owner, configuration, sessions, model startup preferences, and document records.
- `secrets.json` and `veil-identity.json`: service credentials, enrolled users, and devices.
- `documents/`: uploaded documents.
- `qdrant/`, `qdrant.yaml`, and `qdrant-api-key`: vector storage and private database settings.
- `.local/share/caddy/`: TLS certificates and keys. Console reads only the public `root.crt` when creating private-HTTPS enrollment codes.
- `cache/` and `tmp/`: private model-runtime caches and temporary files on Mac; these can be regenerated.

Models live separately in `/Library/Application Support/Umbratic/Veil Console/Models/` on Mac and `/var/lib/umbratic-models/` on Linux. Copy model folders there with the local file manager. For Hugging Face caches, keep each model’s `blobs` and `snapshots` together. Back up this directory separately if you need to preserve the model files; deployment state backups do not include it.

The private `bootstrap.sock` issues an expiring setup code on request; no setup-code file is written. The installer prints the code only after readiness checks pass.

Console supervises Caddy and generates its `Caddyfile` in the state directory from `connection_settings` in SQLite. System services are `/Library/LaunchDaemons/com.umbratic.{console,qdrant}.plist` on Mac, or `/etc/systemd/system/umbratic-{console,qdrant}.service` on Linux. Linux deployment backups remain next to the program directory.

## Release machine

On Mac, release work lives in the repository's ignored `artifacts/release-work/`: `release.env`, signing and feed keys, notarization keys, dependency kits, download caches, deployment packages and `tmp/`. Run release commands from the repository root. Keep this directory owner-only and never force-add its credentials to Git. Windows and Linux keep `~/.umbratic/release.env` and `~/umbratic-release/`.

For a clean local Console setup on Mac, run `sudo python3 scripts/reset-veil-console-macos.py` from the repository root. It unloads and removes the Console and Qdrant services, archives the installed programs, state and previous backups in the invoking user's Trash, and clears known Console test leftovers. Downloaded models and desktop data remain intact. It does not reinstall or start services.

Application bundles still belong in `/Applications/`, launchd registrations in `/Library/LaunchDaemons/`, and project outputs in their repository. Those locations are not duplicate stores of app data.

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

Deployment instructions: [deploy-customer.md](../guides/deploy-customer.md).
