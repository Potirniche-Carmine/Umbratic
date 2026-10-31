# Build a server ZIP

A company or self-hosting administrator builds their own deployment from source. No Umbratic-issued credential or update-feed key is required.

From the repository root:

```sh
npm run veil-console:release -- --customer acme --seats 10 --version 0.0.3
```

The ZIP appears in `artifacts/releases/`, with the administrator-selected label `acme` in its filename. `--seats` and `--devices-per-user` are your deployment's access limits.

The build uses the repository's ignored `artifacts/release-work/` on macOS and `~/umbratic-release/` on Linux:

- `umbratic-entitlement-signing.key` is generated once with owner-only permissions, then reused.
- `metal-kit/` is the reviewed dependency kit on macOS; Linux defaults to `cuda-kit/`.

The command signs your selected limits and embeds the public verification key into Veil and Console. The private signing key stays on the build machine. Back it up privately and reuse it for updates; `--signing-key-file` selects an existing key elsewhere. See [server signing keys](../setup/signing-keys.md).

For an existing deployment, pass `--org-uid` from its previous `entitlement.json` and keep its configured access and search limits. Web search is optional: a nonzero `--searches-per-month` budget requires your own `UMBRATIC_BRAVE_SEARCH_API_KEY` in the build environment or private release environment file. No search credential is needed for a zero budget.

## First build on macOS

Build a fresh dependency kit from the repository root (Python 3.9+, Xcode Command Line Tools, the pinned Go toolchain, and `govulncheck` are required):

```sh
python3 infrastructure/veil-console/deploy/build-metal-kit.py \
  --output "$PWD/artifacts/release-work/metal-kit" \
  --cache "$PWD/artifacts/release-work/download-cache"
```

The output directory must not already exist, so older wheels and executables cannot survive a rebuild. The download and source-build cache can be reused. The kit source-builds Caddy and FFmpeg, applies the reviewed wheel changes, retains corresponding sources/notices, and writes exact offline requirements and a manifest. See the [runtime review](../reference/runtime-security.md#managed-metal-server-kit) for pins, advisory scope and media validation. For a rebuild, select a fresh output folder and pass it to the server ZIP command with `--dependency-dir`.

Qualify the complete offline environment before distributing the kit (the work directory must also be fresh):

```sh
python3 infrastructure/veil-console/deploy/verify-metal-kit.py \
  --kit "$PWD/artifacts/release-work/metal-kit" \
  --work "$PWD/artifacts/release-work/metal-qualification"
```

This installs the full locked environment offline, checks package consistency and Metal plugin imports, then exercises audio, image, video and CLI paths without downloading a model.

macOS builds also need Xcode Command Line Tools for the models-folder launcher. Linux uses an operator-provided dependency kit; its images and packages must be reviewed separately.

The OS and CPU default to this machine. For another supported target, use `--os`, `--arch`, and `--profile`; `--dependency-dir` selects another reviewed kit. Install the target's Rust toolchain before building.

Before distributing the ZIP, complete the [release checks](../../infrastructure/veil-console/SMOKE_TEST.md). Distribute the ZIP and an authenticated checksum, supply your selected model folders, and follow the [self-hosting quickstart](deploy-customer.md). Administrators configure the server address in Console. Desktop application updates come from public GitHub Releases and use no company token.
