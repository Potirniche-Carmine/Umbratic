# Veil Console

Local administration for Veil, models, employees, and documents. The Console stays on loopback; employees connect through its managed HTTPS endpoint.

## Install a server ZIP

1. Verify the ZIP checksum, extract it, and run `sudo ./deploy.sh` from the extracted folder.
2. Open the Console address printed by deployment. For a remote host, use `ssh -N -L 8177:127.0.0.1:8177 USER@SERVER`, then open `http://127.0.0.1:8177`.
3. Enter the printed setup code and create the owner account. The code expires after 15 minutes and works once.
4. In **Veil → Connection**, set the server's VPN address and HTTPS port (default `8432`). Permit that port through the firewall. For public-domain certificates, DNS must point to the server and public TCP 443 must forward to the configured port.
5. In **Models**, open the models folder, copy your model folders, and refresh. Preserve `blobs` and `snapshots` together for Hugging Face caches. Add and start a chat model, then choose the default. Dictation and embedding models are optional.
6. In **Access**, add employees and issue enrollment codes. Each employee enters the shown HTTPS address and their code in Umbratic's **Company server** settings. Private certificates are included in the code.

Model context and sampling settings must suit the checkpoint and available hardware. Document retrieval needs an embedding model. After changing the server address, update clients and issue new codes for pending invitations.

On macOS, server programs, state, models, and deployment backups live under `/Library/Application Support/Umbratic/Veil Console/`. On Linux, programs are under `/opt/umbratic/veil-console/`, state under `/var/lib/veil-console/`, and models under `/var/lib/umbratic-models/`. Back up private state with services stopped, and model files separately. Reuse the signing key and organization ID when rebuilding for an existing deployment. Ordinary redeployment preserves state.

## Build a server ZIP

Run from the repository root after installing the toolchains in the [project README](https://github.com/Potirniche-Carmine/Umbratic#build-and-run). On Apple Silicon macOS, create and qualify a dependency kit first:

```sh
python3 infrastructure/veil-console/deploy/build-metal-kit.py \
  --output "$PWD/artifacts/release-work/metal-kit" \
  --cache "$PWD/artifacts/release-work/download-cache"
python3 infrastructure/veil-console/deploy/verify-metal-kit.py \
  --kit "$PWD/artifacts/release-work/metal-kit" \
  --work "$PWD/artifacts/release-work/metal-qualification"
```

Both output and qualification work directories must be fresh. The build also requires `govulncheck`. Linux uses an operator-reviewed dependency kit supplied with `--dependency-dir`.

```sh
npm run veil-console:release -- --customer acme --seats 10 --version 0.0.2
```

The ZIP is written to `artifacts/releases/`. The build generates an owner-only entitlement signing key on first use; back it up privately. Release work defaults to `artifacts/release-work/` on macOS and `~/umbratic-release/` on Linux. For updates, reuse that key and pass `--org-uid` from the existing `entitlement.json`. `--signing-key-file` selects an existing key; `--os`, `--arch`, and `--profile` select a supported target.

Before distributing, install the ZIP on the target OS and hardware. Verify model startup, enrollment and revocation, restart persistence, HTTPS, and recovery after a failed upgrade. Share its checksum through a trusted channel.

## Develop

From the repository root:

```sh
npm run veil-console:dev
```

Console opens at `http://127.0.0.1:8177`; the terminal prints the first owner setup code. Test from this directory with `go test -race ./...` and `go vet ./...`, then run `npm run test:all` from the repository root.
