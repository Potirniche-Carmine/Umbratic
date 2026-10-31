# Reviewed Caddy source build

The Metal kit builds the standard Caddy distribution from its checksummed Go
module graph. The upstream 2.11.7 binary embeds an older Go toolchain and
dependencies affected by later advisories. This build uses Go 1.26.10,
chi 5.4.0, x/net 0.62.0 and go-jose/v4 4.1.6.

Smallstep's internal-PKI dependency still imports go-jose/v3, which has no fixed
release for its October 2026 advisories. The sole local module replacement is
the reviewed production source in `third_party/go-jose-v3` at the repository
root. It backports the upstream empty-CBC-buffer, JSON nesting and RSA/JWK
validation fixes. Its original licenses, precise source delta, upstream archive
identity and per-file checksums are retained. The root supply-chain gate verifies
every file; it does not suppress advisory results. See
[the runtime review](../../../../docs/reference/runtime-security.md).

On an Apple Silicon Mac, build from the repository root:

```sh
python3 infrastructure/veil-console/deploy/build-caddy.py \
  --output /tmp/metal-kit/bin/caddy --cache /tmp/metal-kit-cache/caddy
```

The helper verifies the source manifest, builds without modifying the locked
graph, checks embedded compiler/module/architecture metadata, adapts the required
HTTPS configuration, and scans the actual binary. Go symbols are retained for
precise binary reachability analysis. It preserves original module notices and
records the effective executable hash and module graph in `caddy.build.json`.
The kit builder hashes those files into its final manifest.

The four backport regressions run through the root quality suite. The complete
original upstream cryptographic suite was also run with the race detector in an
isolated patched copy; the original module cache was never edited.
