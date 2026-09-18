# Preparing a release machine

Do this once per machine. One Mac builds macOS, one Windows PC builds each
Windows architecture.

## 1. R2 credentials (both machines)

1. Cloudflare → **R2** → **Manage R2 API Tokens** → **Create API token**.
2. Name it after the machine (`release-mac`, `release-windows`).
3. Permission **Object Read & Write**, *Specify bucket* → `umbratic-downloads`.
4. Copy the Access Key ID and Secret Access Key. The secret is shown once.
5. Cloudflare → **R2** → **Overview** → note the **Account ID** on the right.

One token per machine, so either can be revoked alone.

## 2. The env file (both machines)

From the repository root on Mac:

```bash
release_dir="$PWD/artifacts/release-work"
mkdir -p "$release_dir"
chmod 700 "$release_dir"
cp docs/release.env.example "$release_dir/release.env"
chmod 600 "$release_dir/release.env"
```

On Windows the path is `%USERPROFILE%\.umbratic\release.env`; Linux uses `~/.umbratic/release.env`.

Fill in the R2 values now. Signing values come from step 3 or 4.

## 3. macOS signing (the Mac only)

You need an Apple Developer Program membership, enrolled as an Organization.
Only the account holder can create Developer ID certificates.

**Certificate:**

1. Xcode → Settings → Accounts → select the team → *Manage Certificates…*
2. **+** → *Developer ID Application*.
3. Confirm it landed:
   ```bash
   security find-identity -v -p codesigning
   ```
   You want a line containing `Developer ID Application: <name> (TEAMID)`.
4. Back it up: Keychain Access → export the certificate **with its private
   key** as a `.p12`, somewhere safe.

Losing that certificate means a new identity, and a new identity cannot update
apps signed with the old one.

**Notarization key:**

1. [App Store Connect](https://appstoreconnect.apple.com) → Users and Access →
   **Integrations** → *App Store Connect API* → *Team Keys*.
2. **Generate API Key**, role **Developer**.
3. Download the `.p8` (shown once) into the repository's ignored `artifacts/release-work/` directory.
4. Note the **Key ID** and the **Issuer ID** from the top of the page.
5. Put all three in `release.env`: `APPLE_API_KEY` (the path),
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

That is all. electron-builder signs with the identity it finds and notarizes
because those variables are present. Without them the build still succeeds,
unsigned, and publishing refuses it.

## 4. Windows signing (the Windows PC only)

Azure Trusted Signing issues short-lived certificates from an HSM Microsoft
runs. There is no certificate file to protect, and SmartScreen trusts it from
the first release.

**In Azure:**

1. Create an Azure account and subscription.
2. Create a **Trusted Signing account** (Basic tier). **East US** is simplest;
   its endpoint is `https://eus.codesigning.azure.net`. Note the account name.
3. Account → *Identity validation* → **New identity** → Public trust,
   Organization. This takes days. The name that comes out is the certificate's
   Subject common name.
4. Account → *Certificate profiles* → **Create** → Public Trust, pick the
   validated identity. Note the profile name.
5. Account → *Access control (IAM)* → give your user the role **Trusted
   Signing Certificate Profile Signer**.

**On the PC:**

1. Install the [.NET 8 Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)
   (x64) and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows).
   `signtool` is already there from the MSVC Build Tools.
2. Sign in once: `az login`. Signing uses that session.
3. Let the first packaging run install the `TrustedSigning` PowerShell module.

**In `release.env`:** `UMBRATIC_WIN_SIGN_ENDPOINT`, `UMBRATIC_WIN_SIGN_ACCOUNT`,
`UMBRATIC_WIN_SIGN_PROFILE`, `UMBRATIC_WIN_SIGN_PUBLISHER`.

The publisher is the identity's exact common name from step 3. Installed apps
verify each update against it, so it must never change between releases.

## 5. Build toolchains

Both machines need the versions pinned in `.nvmrc`, `rust-toolchain.toml`, and
`infrastructure/veil/go.mod`, plus CMake 3.21+.

- **Windows** also needs Ninja and the Vulkan SDK:
  ```bash
  winget install Kitware.CMake Ninja-build.Ninja KhronosGroup.VulkanSDK
  ```
  Open a new terminal afterwards so `VULKAN_SDK` is set.
- **macOS** needs the Xcode Command Line Tools and `brew install cmake`.

Keep these pinned. A toolchain drift on a release machine is a dependency
change — see [../reference/supply-chain.md](../reference/supply-chain.md).

Next: [../guides/release-desktop.md](../guides/release-desktop.md).
