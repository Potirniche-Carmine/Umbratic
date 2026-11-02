# Verify a desktop release

The [Code signing policy](../../CODE_SIGNING_POLICY.md) records current signing
status. Foundation acceptance and signing credentials remain account setup
steps. The commands below apply after a signed release is actually published;
they do not imply that a download or attestation already exists.

Checksums identify bytes. Authenticode/Developer ID identify the applicable code
signer. GitHub build provenance binds published bytes to the release workflow
and source commit. Verify these identities before running the installer.

## GitHub provenance

Use GitHub CLI with `gh attestation verify` support; the release verifier was
tested with CLI 2.97.0. Authenticate to GitHub.com and select the intended
published tag and asset. This example is for the first Windows x64 release;
use the corresponding installer/archive name for another platform or version.

In Bash, including Git Bash on Windows:

```sh
RELEASE_TAG=v0.0.3
ASSET=Umbratic-0.0.3-x64.exe
REPOSITORY=Potirniche-Carmine/Umbratic
RELEASE_COMMIT="$(gh api "repos/$REPOSITORY/git/ref/tags/$RELEASE_TAG" \
  --jq 'select(.object.type == "commit") | .object.sha')"
test "${#RELEASE_COMMIT}" -eq 40

gh release download "$RELEASE_TAG" --repo "$REPOSITORY" \
  --pattern "$ASSET" --pattern SHA256SUMS --pattern release-provenance.jsonl

for FILE in "$ASSET" SHA256SUMS; do
  gh attestation verify "$FILE" \
    --repo "$REPOSITORY" \
    --predicate-type https://slsa.dev/provenance/v1 \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --cert-identity "https://github.com/$REPOSITORY/.github/workflows/release.yml@refs/heads/main" \
    --signer-workflow "$REPOSITORY/.github/workflows/release.yml" \
    --signer-digest "$RELEASE_COMMIT" \
    --source-digest "$RELEASE_COMMIT" \
    --source-ref refs/heads/main \
    --deny-self-hosted-runners || exit 1
done
```

Confirm that the tag's commit is the source you intended to trust. The publisher
requires commit tags and an exact current-main identity before publication.
The verifier hashes each supplied file and checks its authenticated identity;
do not drop the workflow, branch or commit constraints to make a file pass.
Use the same command for any additional downloaded channel, blockmap or Windows
provenance JSON. Every payload and `SHA256SUMS` is an attested subject.

The publisher additionally requires the complete expected subject set, validates
updater metadata against final signed bytes, and verifies the per-architecture
Windows inventory. It rejects a CI attestation from `verify.yml` as evidence for
a signed release from `release.yml`.

## Saved evidence

`release-provenance.jsonl` contains the authenticated attestation bundle.
Adding `--bundle release-provenance.jsonl` to the same verification command uses
that saved evidence. Full offline trust-root preparation is a separate CLI
operation; see the [official verifier manual](https://cli.github.com/manual/gh_attestation_verify).
Prefer the online command above: local-bundle lookup cannot detect a later
repository/owner rename or reuse of that namespace. Never substitute another
repository, workflow or commit to accept an unrelated bundle.

## Operating-system checks

On Windows, inspect **Properties → Digital Signatures** and confirm a valid
signature from the publisher stated by the approved signing policy. The release
also requires a trusted timestamp. The Windows provenance JSON distinguishes
project-signed files from upstream components with original signatures or a
recorded unsigned status. An outer installer signature does not make every
embedded library signed or guarantee Smart App Control acceptance.

On macOS, check the installed app and downloaded disk image:

```sh
codesign --verify --deep --strict /Applications/Umbratic.app
spctl --assess --type execute --verbose /Applications/Umbratic.app
xcrun stapler validate Umbratic-0.0.3.dmg
```

The Developer ID team must match the release's declared Apple team. Inspect its
public identity with `codesign --display --verbose=4 /Applications/Umbratic.app`.
Keep Gatekeeper and normal operating-system trust checks enabled.
