# Storage Layout

Where Umbratic keeps state, on the desktop and on a company server. Two rules
hold throughout: secrets live in files no other account can read, and anything
regenerable lives outside the directories a backup needs to capture.

## Desktop

One data root per user, chosen by platform:

| Platform | Data root |
| --- | --- |
| macOS | `~/Library/Application Support/Umbratic/` |
| Windows | `%LOCALAPPDATA%\Umbratic\` |
| Linux | `$XDG_DATA_HOME/Umbratic/` (default `~/.local/share/Umbratic/`) |

Inside it:

| Path | Contents | Back up |
| --- | --- | --- |
| `state/umbratic.sqlite` | Product state: settings, connection, device identity | Yes |
| `state/chats.sqlite` | Chat history | Yes |
| `state/task-metadata/` | Per-task metadata | Yes |
| `attachments/chats/` | Files attached to chats | Yes |
| `skills/` | Installed skills | Yes |
| `workspaces/scratch/` | Scratch workspaces created for chats | No |
| `worktrees/` | Git worktrees the runner created | No |
| `runtimes/` | Per-workspace runner runtime state | No |
| `artifacts/ocr/` | Rasterized pages cached for OCR | No |
| `cache/electron/` | Electron session cache | No |
| `logs/electron/`, `logs/runner/`, `logs/crash-dumps/` | Diagnostics | No |
| `telemetry/spool/` | Telemetry bundles waiting to upload | No |

Inside a user's own repository the runner writes `.umbratic/` (build output,
runtime state, diagnostics, temporary files). It is workspace-local and
disposable.

## Company server (Ubuntu 24.04, amd64)

Installed by `install.sh` from the release zip.

### Programs, owned by root, replaced on upgrade

| Path | Contents |
| --- | --- |
| `/opt/umbratic/veil-console/veil` | Veil binary |
| `/opt/umbratic/veil-console/veil-console` | Console binary |
| `/opt/umbratic/veil-console/umbratic-pdf` | PDF text extractor Console spawns for `.pdf` uploads |
| `/opt/umbratic/veil-console/entitlement.json` | Signed customer entitlement |
| `/opt/umbratic/veil-console/VERSION` | Installed release version |
| `/opt/umbratic/qdrant/qdrant` | Qdrant vector database binary |

### State, owned by service accounts, preserved across upgrades

| Path | Owner | Mode | Contents | Back up |
| --- | --- | --- | --- | --- |
| `/var/lib/veil-console/console.db` | `veil-console` | 0600 | Owner account, sessions, runtime configuration, document rows, retrieval settings, audit events | Yes |
| `/var/lib/veil-console/secrets.json` | `veil-console` | 0600 | Veil auth token, control token, CSRF signing key | Yes |
| `/var/lib/veil-console/veil-identity.json` | `veil-console` | 0600 | Enrolled users and devices | Yes |
| `/var/lib/veil-console/qdrant-api-key` | `veil-console` | 0600 | Qdrant API key, generated at install | Yes |
| `/var/lib/veil-console/documents/` | `veil-console` | 0700 | Uploaded originals, one file per document id | Yes |
| `/var/lib/qdrant/storage/` | `qdrant` | 0700 | Vectors and chunk payloads | Rebuildable |
| `/var/lib/qdrant/snapshots/` | `qdrant` | 0700 | Qdrant snapshots | No |

The corpus is stored twice on purpose. Originals under
`/var/lib/veil-console/documents/` are the source of truth, so changing the
embedding model re-embeds from them without asking anyone to upload again;
Qdrant holds derived vectors and can be rebuilt from those originals.

Chunk **text** lives in the Qdrant payload, not in `console.db`. That is what
lets Veil answer a chat request without ever opening the Console database.

### Configuration and runtime

| Path | Owner | Mode | Contents |
| --- | --- | --- | --- |
| `/etc/qdrant/config.yaml` | `qdrant` | 0600 | Loopback bind, storage paths, API key, telemetry disabled |
| `/etc/systemd/system/veil-console.service` | root | 0644 | Console unit |
| `/etc/systemd/system/qdrant.service` | root | 0644 | Qdrant unit |
| `/etc/caddy/conf.d/veil-console.caddy` | root | 0644 | HTTPS front end for Veil |
| `/run/veil-console/setup-code` | `veil-console` | 0600 | One-time setup code, removed after 15 minutes |

Veil itself writes no configuration file. Console passes every setting through
an allowlisted child environment, so there is no on-disk Veil config to back up
or drift.

### Ports

All loopback except the Caddy HTTPS listener.

| Port | Service |
| --- | --- |
| 8432 (default) | Caddy HTTPS, the only port desktops reach |
| 8177 | Veil Console, loopback only — reach it over an SSH tunnel |
| 8080 | Veil, loopback only |
| 6333 | Qdrant, loopback only |
| 8000 / 8001 | Chat and embedding model runtimes, loopback only |

### Backup and restore

Stop `veil-console`, copy `/var/lib/veil-console/` whole (including
`documents/`), and restart. Qdrant does not need to be in the backup: after a
restore, re-index from the Documents tab and the corpus is rebuilt from the
stored originals. See [`enterprise-licensing.md`](enterprise-licensing.md) for
entitlement and recovery procedures.
