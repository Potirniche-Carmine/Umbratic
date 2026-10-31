# Releasing the desktop app

GitHub Actions tests, builds and publishes Umbratic. GitHub Releases hosts the
public installers and updater metadata. No Cloudflare account, bucket, Worker,
company enrollment or update token is required.

Supported release targets are macOS 13 or later on Apple Silicon, Windows x64
and Windows ARM64. Each native runner builds the Rust helpers, Veil, Electron shell and
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

The Azure principal needs **Artifact Signing Certificate Profile Signer** on
that profile. Microsoft now calls Trusted Signing **Artifact Signing**; the
existing `UMBRATIC_WIN_SIGN_*` names still name that service. Keep the Apple team, app ID and Windows publisher stable so
installed copies can verify future updates. The Apple secret names match
GamePack; secrets must be configured separately for this repository.

The workflow uses its short-lived `GITHUB_TOKEN` to publish. A personal access
token is unnecessary. Missing signing credentials fail the release before
packaging and cannot result in an unsigned public release.

## Add the signing credentials step by step

1. On the Mac that signs GamePack, open **Keychain Access → My Certificates**.
   Select the same **Developer ID Application** identity, including its private
   key, and choose **File → Export Items**. Save a password-protected `.p12`
   outside the repository. Copy its base64 directly to the clipboard without
   printing the private key in the terminal:
   ```sh
   base64 -i /absolute/path/to/Developer-ID.p12 | pbcopy
   ```
2. Open [Umbratic's Actions secrets settings](https://github.com/Potirniche-Carmine/Umbratic/settings/secrets/actions).
   Choose **New repository secret**, name it `MACOS_CERTIFICATE_P12`, and paste
   the clipboard. Add `MACOS_CERTIFICATE_PASSWORD` with the export password.
   Existing GamePack secrets cannot be read back from GitHub; reuse the
   original certificate or export the same identity again.
3. At [Apple Account](https://account.apple.com), choose **Sign-In and Security
   → App-Specific Passwords → Generate an app-specific password**. Store it as
   `APPLE_NOTARY_PASSWORD`, and store that account's email as
   `APPLE_NOTARY_APPLE_ID`. Two-factor authentication is required. In GitHub's
   **Secrets and variables → Actions → Variables → New repository variable**,
   add `APPLE_TEAM_ID` using the team shown in the Apple Developer membership
   details. Use the same team as the exported certificate.
   [Apple's instructions](https://support.apple.com/en-us/102654).
4. In the [Azure portal](https://portal.azure.com), create or select an
   **Artifact Signing** account, complete identity validation, and create a
   **Public Trust** certificate profile. Record its endpoint, account name,
   profile name and certificate subject common name in the four
   `UMBRATIC_WIN_SIGN_*` repository variables from the table. Private Trust and
   test profiles do not provide the public installer trust this release needs.
   [Microsoft's setup guide](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).
5. In **Microsoft Entra ID → App registrations → New registration**, create a
   signing application. Its **Overview** supplies the tenant and application
   IDs for `AZURE_TENANT_ID` and `AZURE_CLIENT_ID`. Under **Certificates & secrets
   → Client secrets → New client secret**, copy the secret **Value** into
   `AZURE_CLIENT_SECRET`. Assign that application **Artifact Signing Certificate
   Profile Signer** through the signing profile/account's **Access control
   (IAM) → Add role assignment**. Scope it to the profile where possible.
   [Service principal setup](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal),
   [signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles).
6. After `main` has passed **CI required**, open **Actions → Release → Run
   workflow**, select `main`, and run it. The existing `0.0.3` version can be
   released without another bump while it has no published release. All three
   signed builds must pass before the draft becomes public. The pipeline
   provisions its reviewed build/signing tools automatically.
7. Download and install the resulting signed build. For the first GitHub
   release, install it manually if the previous app points at the former feed.
   Qualify automatic installation using a later signed GitHub release with a
   higher version: the installed build must show the update ready, restart,
   and report the new version. This final installed-upgrade check requires
   real signing credentials and two signed versions.

## Cut a release

1. Update all workspace versions together:
   ```sh
   npm run release:version -- 0.0.3
   ```
2. Open and merge a pull request. Require the **CI required** check on `main`.
3. CI runs the complete verification suite, builds unsigned installers and
   archives with production native backends, and validates archive integrity
   plus actual updater checksums on all three native platforms. Windows x64
   exercises the reviewed Vulkan SDK; both Windows hosts also verify the
   credential-free signing-tool setup. Dependency audits and workflow
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
