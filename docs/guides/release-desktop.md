# Releasing the desktop app

GitHub Actions tests, builds and publishes Umbratic. GitHub Releases hosts the
public installers and updater metadata. No Cloudflare account, bucket, Worker,
company enrollment or update token is required.

Supported release targets are macOS Apple Silicon, Windows x64 and Windows
ARM64. Each native runner builds the Rust helpers, Veil, Electron shell and
pinned local runtimes for its own architecture.

## Configure signing once

In the repository's **Settings → Secrets and variables → Actions**, configure:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `MACOS_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate exported with its private key |
| Secret | `MACOS_CERTIFICATE_PASSWORD` | Password protecting that P12 |
| Secret | `APPLE_NOTARY_APPLE_ID` | Apple account authorized to notarize for the team |
| Secret | `APPLE_NOTARY_PASSWORD` | App-specific password for that account |
| Variable | `APPLE_TEAM_ID` | Apple Developer team identifier |
| Secret | `AZURE_TENANT_ID` | Tenant of the signing service principal |
| Secret | `AZURE_CLIENT_ID` | Signing service principal's application ID |
| Secret | `AZURE_CLIENT_SECRET` | Service principal credential |
| Variable | `UMBRATIC_WIN_SIGN_ENDPOINT` | Trusted Signing endpoint, for example `https://eus.codesigning.azure.net` |
| Variable | `UMBRATIC_WIN_SIGN_ACCOUNT` | Trusted Signing account name |
| Variable | `UMBRATIC_WIN_SIGN_PROFILE` | Public-trust certificate profile name |
| Variable | `UMBRATIC_WIN_SIGN_PUBLISHER` | Exact certificate subject common name |

The Azure principal needs **Trusted Signing Certificate Profile Signer** on
that profile. Keep the Apple team, app ID and Windows publisher stable so
installed copies can verify future updates. The Apple secret names match
GamePack; secrets must be configured separately for this repository.

The workflow uses its short-lived `GITHUB_TOKEN` to publish. A personal access
token is unnecessary. Missing signing credentials fail the release before
packaging and cannot result in an unsigned public release.

## Cut a release

1. Update all workspace versions together:
   ```sh
   npm run release:version -- 0.0.3
   ```
2. Open and merge a pull request. Require the **CI required** check on `main`.
3. CI runs the complete verification suite and unsigned packaged-resource
   smoke tests on all three native platforms. Dependency audits and workflow
   validation also run. Pull requests never receive signing credentials.
4. After a successful CI push run for current `main`, the Release workflow
   selects that exact commit and builds signed packages. macOS must pass
   notarization, stapling, code-signature and Gatekeeper checks. Windows must
   pass Authenticode verification for the installer and shipped native files.
5. Publication waits for every platform, validates updater metadata checksums,
   writes `SHA256SUMS`, uploads assets to a draft, and publishes it atomically
   as `v0.0.3`.

Merges that keep an already published version skip release publication. For a
failed release, fix the cause and rerun **Actions → Release → Run workflow**
from `main`. That still requires a successful CI push run for the current
commit. A published release is immutable: bump the version to replace it.
An unpublished draft can be retried; unexpected stale assets make the retry
fail until the draft is removed.

If `main` changes while packaging, publication stops. Run the release against
the newest verified `main` instead of publishing stale output.

## Inspect the result

The release must contain:

- `Umbratic-VERSION.dmg` and `Umbratic-VERSION.zip` for macOS ARM64.
- `Umbratic-VERSION-x64.exe` and `Umbratic-VERSION-arm64.exe` for Windows.
- `latest-mac.yml`, `latest.yml`, `latest-arm64.yml`, blockmaps when produced,
  and `SHA256SUMS`.

Install the signed previous version, leave automatic updates enabled in
**Settings → About**, and confirm it downloads and installs the newer signed
release. Unit tests verify updater state transitions and signature-error
handling; a real installed upgrade additionally verifies the OS trust path.

## Local packaging

For a reversible packaging smoke test without signing credentials:

```sh
npm run desktop:release -- --unsigned --dir
```

`--unsigned` is for local inspection only. Signed local packages require the
credentials described in [release-machine.md](../setup/release-machine.md).
Only GitHub Actions publishes releases; there is no unsigned publishing flag.
