# Cutting a desktop release

Two commands, once the machine is set up
([../setup/release-machine.md](../setup/release-machine.md)):

```bash
npm run desktop:release
```

```bash
npm run publish:release
```

## Steps

1. **Set the version, commit, tag, push.**
   ```bash
   npm run release:version -- 0.0.4
   ```
   ```bash
   git commit -am "Release 0.0.4" && git tag v0.0.4 && git push origin main v0.0.4
   ```
   That writes the version into every `package.json` and the lockfile, so
   nothing is edited by hand. Publishing refuses an untagged or dirty checkout.

2. **Run the tests** if the branch has not been through them:
   ```bash
   npm run test:all
   ```

3. **Build.**
   ```bash
   npm run desktop:release
   ```
   Signs, notarizes (a few minutes — Apple's queue), smoke-tests the package.
   Output lands in `target/release/desktop/`.

4. **Publish.**
   ```bash
   npm run publish:release
   ```
   Checks the tag, the signature, Gatekeeper's verdict, and that the feed is
   not moving backwards. Then uploads, printing each file.

   To see the file list without uploading:
   ```bash
   npm run publish:release -- --dry-run
   ```

5. **Repeat 3–4 on the Windows machine** after
   `git fetch --tags && git checkout v0.0.4`.

Installed apps pick it up on their next check — a few minutes after launch,
then every six hours — and install it when the app quits.

## Getting the app to a client

Send them the installer from `target/release/desktop/`:

- macOS: `Umbratic-<version>.dmg`
- Windows: `Umbratic-<version>-x64.exe` or `-arm64.exe`

SharePoint, email, a shared drive — whatever they already use. It is the same
signed file that was published, and it is the only thing they ever need: from
first launch the app looks after its own updates. There is no download page.

## Rules

1. **Never change the signing identity casually.** macOS updates need the same
   Team ID; Windows updates need the same publisher name. Changing either is a
   coordinated event with a plan for the installed base.
2. **Never re-upload a version's installer with different bytes.** Bump the
   version instead. The script refuses; do not work around it.
3. **Never build from an untagged or dirty tree.** `v0.0.4` must be the same
   commit on both machines.

## When it goes wrong

| Message | Fix |
| --- | --- |
| `HEAD is not tagged` / `working tree has uncommitted changes` | Tag and rebuild. The build must come from the tag. |
| `This build is not releasable` (Mac) | `spctl` did not say *Notarized Developer ID*. Usually the `APPLE_*` variables are missing or wrong, or the certificate is not in the keychain. |
| `Authenticode status NotSigned` (Windows) | The four `UMBRATIC_WIN_SIGN_*` values are missing, or `az login` expired. |
| `already serves X, which is newer` | You are publishing older than the feed has. To pull a bad release, publish a newer good one. |
| App says *Could not reach downloads.umbratic.ai* | The custom domain is not Active in R2, or the machine is offline. |
| App says *No release is published for this platform yet* | That architecture has no release. Windows x64 and arm64 are separate. |

`--allow-unsigned` publishes a build that failed the signing check. Pass it
with `--`, or npm eats it:

```bash
npm run publish:release -- --allow-unsigned
```

It exists for testing the pipeline before certificates exist. Nobody's
installed copy will update to such a build — the updater downloads it, fails
the signature check, and discards it.

## How the pieces fit

| Piece | Job |
| --- | --- |
| `apps/desktop/electron-builder.yml` | Names the feed. Building writes `latest-mac.yml` / `latest.yml` next to the installers and bakes the address into the app. |
| `apps/desktop/src/main/appUpdates.ts` | The in-app side. Checks a few minutes after launch and every six hours; no on-demand check exists. Settings → About holds the one switch. |
| `infrastructure/downloads-worker/` | The feed. The only route to the bucket. See [../setup/update-feed.md](../setup/update-feed.md). |
| `scripts/publish-release.ts` | Uploads installers first, the channel file last, so the feed never names a file that is not there. |
| `~/.umbratic/release.env` | The machine's identity — notarization key, signing account, R2 credentials. |

Windows x64 and arm64 are separate builds with their own channel files, because
their sidecars are compiled for the machine that builds them. Each is published
from a machine of that architecture. An architecture with no release sees no
update — never the other one's installer.
