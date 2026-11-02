# Caddy source build

The Metal dependency kit builds Caddy from the pinned Go module graph, with the reviewed go-jose/v3 backport in [third_party/go-jose-v3](../../../../third_party/go-jose-v3). Source provenance, licenses, and file checksums are retained there.

From the repository root:

```sh
python3 infrastructure/veil-console/deploy/build-caddy.py \
  --output /tmp/metal-kit/bin/caddy --cache /tmp/metal-kit-cache/caddy
```

The builder verifies the source manifest, scans the resulting binary, and records its hash and module graph in `caddy.build.json`.
