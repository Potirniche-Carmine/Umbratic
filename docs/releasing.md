# Releasing the desktop app

Umbratic is handed to clients directly — the `.dmg` or `.exe` from a build,
sent however the client receives files — and from then on the installed app
keeps itself current from `https://downloads.umbratic.ai`, a Cloudflare R2
bucket that is linked from nowhere. Releases are built and signed on our own
machines — one Mac for macOS, one Windows PC per Windows architecture — and
pushed up with a script. Nothing about a release runs on a shared build
service, and no signing key or upload credential lives in the repository.

Two commands make a release once a machine is set up:

```sh
npm run desktop:release    # build, sign, notarize, verify
npm run publish:release    # upload to downloads.umbratic.ai
```

Everything else in this document is the one-time setup behind them, and the
few rules that keep every release installable.

## How it fits together

- `apps/desktop/electron-builder.yml` names the feed (`publish.url`). Building
  writes `latest-mac.yml` (macOS) or `latest.yml` (Windows) next to the
  installers, and bakes the address into the app as `app-update.yml`.
- `apps/desktop/src/main/appUpdates.ts` is the in-app side: electron-updater
  reads the channel file, downloads the installer in the background, checks its
  signature, and installs on the next quit. Settings → About shows the state,
  offers "Check now", and holds the one switch: whether to check automatically.
- `scripts/publish-release.ts` uploads. Installers and blockmaps first, the
  channel file last, so the feed never names a file that is not there.
  Published installers are immutable; the channel file never moves backwards;
  an unsigned build is refused.
- `~/.umbratic/release.env` is the machine's identity — notarization key on the
  Mac, signing account on Windows, R2 credentials on both. Template:
  `scripts/release.env.example`.

Windows x64 and arm64 are separate builds with their own channel files
(`latest.yml`, `latest-arm64.yml`), because their sidecars are compiled for
the machine that builds them. Each is published from a machine of that
architecture; an architecture with no release yet sees no update, never the
other one's installer.

## One-time setup

### 1. Cloudflare R2 (do this first — everything else can be tested against it)

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**. Name it
   `umbratic-downloads`, location Automatic. Leave everything else default.
2. Open the bucket → **Settings** → **Custom Domains** → **Connect Domain** →
   `downloads.umbratic.ai`. The zone is already on Cloudflare (Pages serves the
   site from it), so this creates the DNS record and certificate for you. Wait
   until it shows Active.
3. **R2 Object Storage** → **Overview** → note the **Account ID** shown on the
   right.
4. **Manage R2 API Tokens** → **Create API token**: name it after the machine
   (`release-mac`, `release-windows`), permission **Object Read & Write**,
   *Specify bucket* → `umbratic-downloads`. Copy the Access Key ID and Secret
   Access Key — the secret is shown once. Make one token per machine so either
   can be revoked alone.
5. *Optional — keep the feed to the app.* The bucket is public over its domain
   because installed apps fetch from it without credentials, but it is not
   linked from anywhere and nothing needs to be. To stop a browser or a
   guessed URL from downloading installers, add one WAF rule: Cloudflare
   dashboard → the `umbratic.ai` zone → **Security → WAF → Custom rules** →
   *Create rule*, expression
   `(http.host eq "downloads.umbratic.ai" and not starts_with(http.user_agent, "Umbratic/"))`,
   action **Block**. The app announces itself as `Umbratic/<version>` and is
   the only client the feed is for. This is a fence, not a lock — anyone
   determined can send that header — which is the right level for "not just
   anyone": what it protects is a signed installer, not a secret.

### 2. The release env file (both machines)

```sh
mkdir -p ~/.umbratic && chmod 700 ~/.umbratic
cp scripts/release.env.example ~/.umbratic/release.env
chmod 600 ~/.umbratic/release.env
```

Fill in the R2 values now. The signing sections come from steps 3 and 4.
On Windows the path is `%USERPROFILE%\.umbratic\release.env`.

### 3. macOS: Developer ID and notarization (the Mac only)

Prerequisite: an Apple Developer Program membership. Enrol as an Organization
once the D-U-N-S number arrives; the account holder is the only role that can
create Developer ID certificates.

1. **Certificate.** Xcode → Settings → Accounts → select the team → *Manage
   Certificates…* → **+** → *Developer ID Application*. It lands in the login
   keychain, which is where electron-builder looks. Confirm with:
   ```sh
   security find-identity -v -p codesigning
   ```
   You should see one line containing `Developer ID Application: <name> (TEAMID)`.
   Back it up: Keychain Access → export the certificate *with its private key*
   as a `.p12` to a safe place. Losing it means a new identity, and a new
   identity cannot update apps signed with the old one.
2. **Notarization key.** [App Store Connect](https://appstoreconnect.apple.com)
   → Users and Access → **Integrations** → *App Store Connect API* → *Team
   Keys* → **Generate API Key**, role **Developer**. Download the `.p8` (shown
   once) into `~/.umbratic/`, and note the **Key ID** and the **Issuer ID** at
   the top of the page. Put all three in `release.env` as `APPLE_API_KEY`
   (path), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

That is the whole macOS setup: electron-builder signs with the identity it
finds and notarizes because the `APPLE_*` variables are present. Without them
the build still succeeds, unsigned, and `publish:release` refuses it.

### 4. Windows: Azure Trusted Signing (the Windows machine only)

Trusted Signing (Microsoft is renaming it Artifact Signing) issues short-lived
certificates from an HSM Microsoft runs; there is no certificate file to
protect, and SmartScreen trusts it from the first release.

1. **Azure.** Create an Azure account and subscription, then in the portal
   create a **Trusted Signing account** (Basic tier). Region: **East US** is
   simplest; whichever you pick, its endpoint is what goes in `release.env`
   (`https://eus.codesigning.azure.net` for East US; the region table is in
   [Microsoft's docs](https://learn.microsoft.com/azure/trusted-signing/how-to-signing-integrations)).
   Note the **account name**.
2. **Identity validation.** In the account → *Identity validation* → **New
   identity** → Public trust, Organization. This is the slow step (days); the
   name that comes out is the certificate's Subject common name.
3. **Certificate profile.** In the account → *Certificate profiles* → **Create**
   → Public Trust, pick the validated identity. Note the **profile name**.
4. **Permission.** The account → *Access control (IAM)* → give your user the
   role **Trusted Signing Certificate Profile Signer**.
5. **On the PC:**
   - Install the [.NET 8 Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)
     (x64) and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows).
     The Windows SDK's `signtool` is already there from the MSVC Build Tools
     the llama.cpp build needs.
   - Sign in once: `az login`. Signing uses that session; nothing else is
     stored. (A service principal via `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
     `AZURE_CLIENT_SECRET` in `release.env` also works, and is what an
     unattended machine would use.)
   - The first packaging run installs the `TrustedSigning` PowerShell module
     from the PowerShell Gallery for the current user; let it.
6. In `release.env`: `UMBRATIC_WIN_SIGN_ENDPOINT`, `UMBRATIC_WIN_SIGN_ACCOUNT`,
   `UMBRATIC_WIN_SIGN_PROFILE`, and `UMBRATIC_WIN_SIGN_PUBLISHER` — the last
   is the identity's exact common name from step 2. Installed apps verify each
   update against it, so it must not change between releases.

`apps/desktop/scripts/package.ts` passes these four to electron-builder on the
command line; they are deliberately not in `electron-builder.yml`, so a
developer or CI packaging without them gets an unsigned build rather than a
signing failure.

## Cutting a release

On the Mac (the Windows machine repeats from step 3):

1. Set the version, commit, and tag it:
   ```sh
   npm run release:version -- 0.0.4
   git commit -am "Release 0.0.4" && git tag v0.0.4 && git push origin main v0.0.4
   ```
   The first line writes `0.0.4` into every `package.json` (root and each
   workspace — the app's version is the desktop package's) and into
   `package-lock.json`, so nothing is edited by hand and the lockfile is never
   out of step. `publish:release` refuses an untagged or dirty checkout — a
   version means one commit, and both machines must build the same one.
2. `npm run test:all` if the branch has not been through it.
3. Build:
   ```sh
   npm run desktop:release
   ```
   Signs, notarizes (a few minutes — Apple's queue), and smoke-tests the
   package. Output lands in `target/release/desktop/`.
4. Publish:
   ```sh
   npm run publish:release
   ```
   It checks the tag, the signature, Gatekeeper's verdict and that the feed is
   not moving backwards, then uploads and prints each file as it goes. (Add
   `-- --dry-run` to see that list without uploading anything — useful the
   first time, or after changing the bucket; not part of a normal release.)
5. On the Windows machine: `git fetch --tags && git checkout v0.0.4`, then
   steps 3–4. Publish the arm64 build from an arm64 PC the same way when there
   is one; until then, arm64 clients get the installer by hand and see no
   updates.

Installed apps pick the release up on their next check (a few minutes after
launch, then every six hours) or when someone presses "Check now", and install
it when the app quits.

## Getting the app to a client

Send them the installer: `target/release/desktop/Umbratic-<version>.dmg` from
the Mac, `Umbratic-<version>-x64.exe` (or `-arm64.exe`) from the Windows
machine — by SharePoint, email, a shared drive, whatever they already use. It
is the same signed file that was published, and it is the only thing they ever
need from us: from the first launch the app looks after its own updates. There
is no download page and none is needed. If a client would rather fetch it
themselves, the bucket's own dashboard (R2 → the bucket → the object → the
copied link) gives a URL, subject to the WAF rule above if you enabled it.

## Rules that keep every release installable

- **Never change the signing identity casually.** macOS updates require the
  same Team ID; Windows updates require the same publisher name. A change is
  a coordinated event with a plan for the installed base, not a config edit.
- **Never re-upload a version's installer with different bytes.** The script
  refuses; do not work around it. Bump the version.
- **Never build a release from an untagged or dirty tree.** The script refuses
  that too. The point is that `v0.0.4` on both machines is the same commit.
- **Keep the release machines on the pinned toolchains** (`.nvmrc`,
  `rust-toolchain.toml`, Go, CMake, the Vulkan SDK on Windows). The machine is
  the build infrastructure; a toolchain drift there is a dependency change.

## If something goes wrong

- *"HEAD is not tagged"* / *"working tree has uncommitted changes"* — tag and
  rebuild. The build has to come from the tag.
- *"This build is not releasable"* on the Mac — `spctl` did not say *Notarized
  Developer ID*. Usually the `APPLE_*` variables were missing or wrong (the
  package log says "skipped macOS notarization"), or the certificate is not in
  the keychain. Fix and rebuild. `--allow-unsigned` exists for testing the
  pipeline against the bucket before certificates exist; nobody's installed
  copy will update to such a build.
- *"Authenticode status NotSigned"* on Windows — the four `UMBRATIC_WIN_SIGN_*`
  values are missing, or `az login` has expired. Run `az login` and rebuild.
- *"already serves X, which is newer"* — you are publishing an older version
  than the feed has. That is never right; if a bad release must be pulled,
  publish a newer version that is good.
- An installed app shows *"Could not reach downloads.umbratic.ai"* — the
  custom domain is not Active in R2, or the machine is offline. *"No release
  is published for this platform yet"* is the arm64 case above.
