# Release action advisory review

This review covers the exact official SignPath and GitHub attestation action
revisions used by the release workflow. These bundled dependencies sit outside
the application npm lockfile. They are not all patched upstream; the configured
paths described below avoid the affected operations. This is an applicability
review, not a claim that every upstream action path is safe.

`npm run supply-chain:check` verifies the reviewed workflow and verification
control hashes. `npm run supply-chain:audit` additionally downloads the exact
action sources, checks their SHA-256 identities, and queries OSV. A new or
changed advisory, changed source blob, changed control, or incomplete response
fails the audit. Withdrawn or otherwise removed matches also require the record
to be reconciled. No package-wide advisory ignores are used.

Exact IDs, modified timestamps, package versions, source hashes and individual
dispositions are in
[`release-actions-security.json`](../../third_party/release-actions-security.json).
The current audit output is `artifacts/supply-chain/release-actions-osv-review.json`.

## GitHub attestation action

[`actions/attest` v4.2.2](https://github.com/actions/attest/tree/1e69f48acb82d1966a394da916b4c1698aa569d6)
is pinned by commit. Its non-development npm lock graph is a conservative
inventory: it can include code that the bundle does not execute. The exact
published bundle is also checksum-verified.

The current raw matches cover Undici, glob/minimatch/brace expansion,
`ip-address`, `csv-parse`, and `@sigstore/core`. Both attestation steps use only
a fixed upload-directory glob after complete-file validation. They accept no
untrusted glob expressions, CSV checksum input, custom predicate, registry,
network destination or IP-based authorization policy. WebSocket, EventSource,
cookie helper, retry-interceptor and user-supplied Blob operations are unused.
Network requests go to official GitHub/Sigstore services; their availability
and trust remain dependencies of the signing service.

The [DSSE type-binding advisory](https://github.com/advisories/GHSA-jfc7-64v2-mr8c)
affects the bundle's JavaScript PAE implementation for non-ASCII payload types.
The action generates the fixed ASCII type `application/vnd.in-toto+json`.
Publication uses the independent Go GitHub CLI verifier, constrains the exact
certificate/workflow/ref/source and signer commits, and requires that exact
ASCII envelope type and complete subject set. JavaScript bundle verification
and arbitrary payload types are not accepted.

## SignPath action

[`github-action-submit-signing-request` v3.0](https://github.com/SignPath/github-action-submit-signing-request/tree/f6d04783b4569d051e0c80105fe66e82819d0092)
publishes only its packaged Node entrypoint and action metadata, without a
release lockfile. The audit verifies those exact files and the version markers
of Axios 1.19.0 and Moment 2.29.4. This is not a complete transitive dependency
SBOM for that upstream action.

The action uses explicit GET/POST aliases, JSON requests and streamed downloads
with the default Node HTTP/1 adapter. The affected HTTP/2, fetch, form serializer
and `data:` URL paths are unused. Its logging interceptor preserves the existing
request config. Workflow inputs contain fixed artifact-configuration names and
validated version/architecture values; no arbitrary object/config merge or
attacker-controlled URL is provided. The connector URL remains the official
HTTPS default. Proxy-CIDR/private-IP exclusions are not used to authorize these
public service destinations. The socket-hijack gadget requires an independent
same-process prototype-pollution source; none was identified in this configured
input path.

The [Moment advisory](https://github.com/moment/moment/security/advisories/GHSA-4p3w-j4w9-5jqw)
requires an attacker-influenced non-string locale. The action formats numeric
timeouts and durations; it accepts no locale input. Returned ZIP archives use
the action's standard entry-name validation. The unsafe header-filename path of
`skip-decompress: true` is not selected.

Signed output still must have the exact requested filenames, unchanged
non-signature PE bytes, trusted project identity, timestamp and product metadata.
The action's success alone cannot authorize a replacement binary. See the
[code signing policy](../../CODE_SIGNING_POLICY.md) for Foundation eligibility,
approval requirements and the Windows trust limits of unsigned upstream files.

This review does not replace operating-system trust checks, provider security,
or future advisory review. A compromised trusted signing or attestation service
can deny availability; these checks do not assert that unknown vulnerabilities
are absent.
