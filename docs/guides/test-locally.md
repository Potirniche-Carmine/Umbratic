# Testing locally

Run the full source verification gate from the repository root:

```sh
npm ci --ignore-scripts --omit=peer
npm run dependencies:provision
npm run test:all
```

Inspect a native desktop package without release credentials:

```sh
npm run desktop:release -- --unsigned --dir
```

This builds and smoke-tests the packaged Rust helpers, Veil and pinned runtime
resources. Unsigned local packages are never published. Windows x64 requires
the Vulkan SDK unless `UMBRATIC_LLAMA_CPU_ONLY=1` is explicitly enabled for a
local packaging rehearsal; signed releases reject that setting.

For server testing, follow [deploy-customer.md](deploy-customer.md) to start a
self-hosted Veil Console, create the owner account and enroll a desktop. Each
user receives their own enrollment code. Remote clients need a reachable HTTPS
or private-network server address.

Desktop updates work separately from server enrollment. A packaged app checks
public GitHub Releases 45 seconds after launch, then every six hours when
automatic updates are enabled in **Settings → About**. A development build
never checks. No update license or company token is required.

An actual installed upgrade requires a signed previous build and a newer
signed release with the same Apple team or Windows publisher. An unsigned
packaging smoke test cannot prove that OS signature trust path. See the
[release guide](release-desktop.md) for the complete signed release procedure.
