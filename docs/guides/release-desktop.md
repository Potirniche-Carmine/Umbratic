# Releasing the desktop app

GitHub Actions builds verified `main` commits and publishes installers and updater
metadata to GitHub Releases. No Cloudflare bucket, company enrollment or update
token is needed. Targets are macOS 13+ on Apple Silicon and Windows x64/ARM64.

The [Code signing policy](../../CODE_SIGNING_POLICY.md) records current status and
scope. SignPath Foundation acceptance and account setup are still pending;
preparing this integration does not grant a certificate or make a signed release.

## Configure Apple signing

Use the same valid Developer ID Application identity and Apple Developer team
used by GamePack. Keep Umbratic's bundle ID `ai.umbratic.desktop` distinct and
stable. Configure these Umbratic repository Actions settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `MACOS_CERTIFICATE_P12` | Base64 of the existing protected Developer ID Application P12, including its private key |
| Secret | `MACOS_CERTIFICATE_PASSWORD` | Password protecting that P12 |
| Secret | `APPLE_NOTARY_APPLE_ID` | Existing Apple account authorized to notarize for the team |
| Secret | `APPLE_NOTARY_PASSWORD` | That account's app-specific notarization password |
| Variable | `APPLE_TEAM_ID` | The team associated with the certificate and notarization account |

GamePack's checked-in configuration identifies team `P3UF4Y6ASK` and certificate
SHA-1 `FB6753A6FCBE197440100A34EB795D25C2F259AC`. These are public configuration
identifiers, not evidence that the private key is available or the certificate
is currently valid. The reviewed local keychain contained no valid signing
identity or public Developer ID Application certificate.

Restore the original protected P12 from its secure backup, or let the owner
prepare it on the actual GamePack signing machine. No new certificate is needed
merely because Umbratic is another app; the certificate must still be valid and
belong to the selected team. Reuse the existing authorized notarization account
and password if available. Never place credentials in the repository or chat.

The four secret names match GamePack, but personal-account repositories have
separate secret stores. [GitHub does not return stored secret values](https://docs.github.com/en/rest/actions/secrets#get-a-repository-secret),
so they cannot be copied back through the API. Configure Umbratic from the
original protected material in [Actions secrets settings](https://github.com/Potirniche-Carmine/Umbratic/settings/secrets/actions).
The workflow imports the identity into a temporary hosted-runner keychain,
derives its fingerprint for the selected team, checks signing/notarization
access and cleans up the keychain. GamePack itself is not modified.

## Configure SignPath after acceptance

First review the [application preparation](../setup/signpath-application.md).
The owner submits it, supplies contact details and explicitly reviews the
required Code of Conduct and personal-data-processing agreements. Optional
marketing consent is the owner's choice. The project has no published release;
prior-release and reputation eligibility must be resolved with the Foundation.

Install the [SignPath GitHub App](https://github.com/apps/signpath) only after
reviewing its permissions. The reviewed screen requests read access to Actions,
code and metadata, and **read/write repository administration**. Choose the
personal account, **Only select repositories**, and **Potirniche-Carmine/Umbratic**
only. Neither installation nor the final permission grant has been performed.

In SignPath, link the GitHub trusted build system and this repository. Require
origin verification for `main`, manual approval of every signing request, MFA
for the people in the public policy, and a CI submitter that cannot approve its
own requests. Obtain explicit Foundation approval for the Electron-derived
launcher and exact artifact scope; changing Electron's branding is insufficient.

Before enabling production signing, merge a reviewed PR updating the public
[Code signing policy](../../CODE_SIGNING_POLICY.md) with the accepted scope,
exact publisher, active roles and approval status.

Create these artifact configurations from the reviewed repository XML:

| Slug | Source | Scope |
| --- | --- | --- |
| `umbratic-payload-v1` | [payload XML](../../scripts/ci/signpath/umbratic-payload-v1.xml) | Declared project executables, including the explicitly reviewed Electron-derived launcher |
| `umbratic-uninstaller-v1` | [uninstaller XML](../../scripts/ci/signpath/umbratic-uninstaller-v1.xml) | Generated NSIS uninstaller |
| `umbratic-installer-v1` | [installer XML](../../scripts/ci/signpath/umbratic-installer-v1.xml) | Final NSIS installer |

They enforce the Umbratic product name and matching release version. Do not
broaden patterns to cover upstream libraries or disable origin/approval checks.
After acceptance, add these Actions settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | Restricted CI submitter token; used only by the official SignPath Action |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organization identifier |
| Variable | `SIGNPATH_PROJECT_SLUG` | Approved project slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Approved release policy requiring manual approval and trusted origin |
| Variable | `SIGNPATH_PUBLISHER` | Exact certificate subject common name supplied for the approved project |

Do not guess the publisher or use a test certificate. Missing configuration
stops release signing; it never falls back to publishing unsigned packages.

## Cut and approve a release

1. Update all workspace versions with `npm run release:version -- VERSION`,
   merge the reviewed change and wait for the complete `CI required` check.
   CI builds unsigned production installers on every target, checks native
   resources, archives and updater digests, and produces separate CI provenance.
   Pull requests receive no distribution signing credentials.
2. A successful CI push for current `main` triggers **Release**. Source selection
   rejects stale, fork, PR, failed or unrelated builds. macOS signing includes
   notarization, stapling, signature and Gatekeeper checks.
3. For each Windows architecture, the same packaging process pauses for three
   SignPath requests: payload, NSIS uninstaller and final installer. Review the
   exact source commit, workflow, artifact configuration and requested files,
   then approve each request in SignPath. Expect **six requests per release**
   across x64 and ARM64, each with a 30-minute completion window.
4. The builder resumes with the checked signed bytes, including the exact
   uninstaller used by NSIS. Project executables need the approved publisher,
   timestamp, product name and version. Upstream binaries retain verified
   original bytes and recorded signature status; they are not blanket-signed
   with the project certificate. The per-architecture provenance inventory
   records this distinction. Unsigned upstream code can still be blocked by
   Windows Smart App Control.
5. Publication waits for all platforms. It validates the complete final signed
   asset set and updater metadata, writes `SHA256SUMS`, generates GitHub build
   provenance over those final bytes, and cryptographically verifies the
   attestation's exact workflow, `main` commit, hosted runner and subjects.
   Assets upload to a draft; a final live-main check precedes publication.

For the first release, the existing version can be used while it remains
unpublished. Set account configuration first, wait for successful current-main
CI, then run **Actions → Release → Run workflow** on `main` if the automatic run
stopped on missing credentials. Already-published versions are immutable and
skipped; bump the version to publish different bytes. A stale main commit or
unexpected draft asset stops publication.

## Inspect the result

A signed release contains:

- `Umbratic-VERSION.dmg` and `Umbratic-VERSION.zip` for macOS ARM64.
- `Umbratic-VERSION-x64.exe` and `Umbratic-VERSION-arm64.exe` for Windows.
- `latest-mac.yml`, `latest.yml`, `latest-arm64.yml` and generated blockmaps.
- `Umbratic-VERSION-x64-windows-provenance.json` and
  `Umbratic-VERSION-arm64-windows-provenance.json`.
- `SHA256SUMS` and the authenticated `release-provenance.jsonl` bundle.

Follow [download verification](verify-release.md) before installing. Then qualify
an installed upgrade from a signed earlier version to a later signed version:
check **Settings → About**, download, restart and confirm the new version and
preserved user data. This requires real signing accounts and two signed releases;
unit tests and unsigned CI builds do not replace it.

## Local inspection

Use `npm run desktop:release -- --unsigned --dir` for a reversible local package.
Signed local macOS inspection is described in
[release-machine.md](../setup/release-machine.md). Windows distribution signing
runs only through the approved hosted workflow; a local token or binary upload
cannot substitute for trusted origin. Only GitHub Actions publishes releases.
