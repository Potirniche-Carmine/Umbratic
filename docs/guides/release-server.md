# Build a customer ZIP

From the repository root:

```sh
npm run veil-console:release -- --customer acme --seats 10 --version 0.1.0
```

The ZIP appears in `artifacts/releases/`, with `acme` in its filename.

The build uses the repository's ignored `artifacts/release-work/` on Mac and `~/umbratic-release/` on Linux automatically:

- `umbratic-feed-master.key`: your existing master key.
- `umbratic-entitlement-signing.key`: created once if missing, then reused.
- `metal-kit/`: the dependency kit on Mac (`cuda-kit/` by default on Linux).

Customer update keys are derived automatically from the master key. Neither master key nor signing key goes into the ZIP. Back up both files; if you already have a signing key elsewhere, put the original here before building.

For an existing deployment, add `--org-uid` with the value from its previous ZIP’s `entitlement.json`. Keep its configured `--searches-per-month` allowance if applicable.

## First-time Mac setup

Put your feed master key at `artifacts/release-work/umbratic-feed-master.key`. If the kit is missing, build it once from the repository root:

```sh
python3 infrastructure/veil-console/deploy/build-metal-kit.py \
  --output "$PWD/artifacts/release-work/metal-kit" \
  --cache "$PWD/artifacts/release-work/download-cache"
```

Mac builds need the Xcode command-line tools to compile the models-folder launcher.

The OS and CPU default to this machine. For another supported target, use `--os`, `--arch`, and `--profile`; `--dependency-dir` selects another reviewed kit. Build with the target’s Rust toolchain.

Before sending the ZIP, complete the [release checks](../reference/dependency-kits.md). Send the customer their ZIP, its authenticated checksum, model folders, and the [quickstart](deploy-customer.md). They configure their server address in Console.
