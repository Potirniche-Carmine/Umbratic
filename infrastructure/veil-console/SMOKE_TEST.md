# Server verification

Internal checklist; customers receive only [Quickstart](../../docs/guides/deploy-customer.md).

Build and install the target ZIP using the [release guide](../../docs/guides/release-server.md). Record the OS, GPU, exact dependency versions, model revisions, and ZIP checksum with the results.

- Before installation: reject a modified or incomplete ZIP, wrong architecture, occupied port, and insufficient disk space.
- Fresh installation: Console and trusted HTTPS respond before any model exists; setup is single-use and absent from service logs; the control API is unavailable through HTTPS.
- Access: enroll a device, reject reuse of its code, enforce operator-configured seat limits and per-user device limits, revoke a device, deactivate a user, and verify authorization immediately changes.
- Models: add supported chat, embedding, and speech checkpoints; verify their actual endpoints, failure messages, and concurrent requests through Veil. Stop and restart models without orphan processes.
- Models folder: open it from Console in Finder on Mac and the default file manager on Linux. Copy a standalone model and a complete Hugging Face model cache, refresh, and verify detected names and model startup. An incomplete cache shows its folder name and an error. On headless Linux, copy to `/var/lib/umbratic-models` and refresh. No model data passes through the browser.
- Persistence: restart services and confirm enabled models, owner, enrolled devices, and documents survive. Redeploy for the same organization and verify recovery after a failed upgrade.
- Host lifecycle: test logout, reboot, and GPU access under the dedicated service account. On Mac, unlock FileVault after restart. Repeat on each supported Linux GPU profile.

Run `npm run test:all`, plus Go race tests and vet in both services. A development-process check does not replace installing the actual ZIP on the target host.

Connection configuration: verify a fresh deployment binds employee HTTPS to loopback only. In Console, apply a VPN IP and unused port, connect from a VPN client using a new enrollment code, and confirm `/api/control` and `/api/control/users` return 404 through HTTPS. Confirm an occupied port leaves the old endpoint working, certificates survive a change and redeploy, and stopping Console reaps Caddy. Public-domain mode requires a real domain with TCP 443 forwarded to the configured HTTPS port; verify issuance and renewal on the target network.
