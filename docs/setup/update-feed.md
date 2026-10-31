# Desktop updates

Public [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases)
serve Umbratic installers and updater metadata. `electron-builder.yml` embeds
that repository in the packaged app. `electron-updater` reads the latest stable
release and verifies the downloaded package using the platform signature.

macOS uses `latest-mac.yml` and the signed ZIP. Windows x64 uses `latest.yml`;
Windows ARM64 uses `latest-arm64.yml`. The architecture is also part of each
Windows installer name, so one architecture cannot replace another's asset.
Downgrades and prereleases are disabled.

Automatic checks begin 45 seconds after launch and repeat every six hours.
Turn them off in **Settings → About**. Development builds never check. Updates
are independent of local/server mode, company licenses, enrollment and Veil.
No company token, account credential or device identifier is sent by Umbratic's
updater; requests include a User-Agent naming the app version and platform.
GitHub receives normal network request metadata.

Configure signing and publication using the
[desktop release guide](../guides/release-desktop.md). No Cloudflare resources
are part of the update path. Old installations that embed the former
Cloudflare feed must install the GitHub-hosted build once to switch feeds.
