# Server signing key

A company or self-hosting administrator generates and owns the signing key for their deployment. No Umbratic-issued key or update-feed master key is required.

The server release command creates an Ed25519 signing key on its first run, with owner-only permissions. On macOS the default file is `artifacts/release-work/umbratic-entitlement-signing.key`; on Linux it is `~/umbratic-release/umbratic-entitlement-signing.key`. Use `--signing-key-file` to choose another location.

The command signs the administrator-selected seat, device, and optional search limits and embeds the corresponding public key in Veil and Console. Those limits are deployment policy chosen by the administrator. Keep the private key out of source control and customer bundles. Back it up privately and reuse it when rebuilding that deployment.

To generate a signed policy directly from source:

```sh
cd infrastructure/veil-console
go run ./cmd/entitlement \
  --output /path/to/deployment/entitlement.json \
  --private-key-file /path/to/private/signing.key \
  --seats 100 \
  --devices-per-user 2
```

The command prints only the public key. The release script embeds that key automatically; manual builds pass it to both binaries with their respective `internal/entitlement.TrustedPublicKey` linker variable. Keep the generated `org_uid` by passing `--org-uid` on subsequent policy generation.

Web search is optional and requires the administrator's own Brave Search API credential and a nonzero search budget. It is unrelated to application updates, which use public GitHub Releases.

Next: [build a server ZIP](../guides/release-server.md).
