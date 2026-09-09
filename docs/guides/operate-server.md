# Server operations

For first installation, use the [customer quickstart](deploy-customer.md).

- **Models:** upload or copy supplied folders, register their role, and start them. Stopping a model disables automatic startup; restarting Console preserves which models are enabled. Check a failed model's Output before trying again. Runtime support depends on architecture and quantization, not just file extension.
- **Employees:** manage seats, enrollment codes, deactivation, and device revocation in Access. Purchased seats work offline and do not expire when support ends.
- **Restart:** use Console for Veil. Restart the Console service to restore all enabled models. Linux: `sudo systemctl restart umbratic-console`. Mac: `sudo launchctl kickstart -k system/com.umbratic.console`.
- **Redeploy:** use a verified ZIP for the same organization and run `sudo ./deploy.sh`. Deployment stops services, backs up program and state together, preserves credentials and content, and restores the backup on failure. Keep the backup path printed by the installer.
- **Backup:** stop both Umbratic services before copying the program directory, service definitions, and the entire state directory. The state includes SQLite, company identity, secrets, documents, Qdrant, and Caddy's TLS identity. Back up the adjacent Models directory separately on Mac. Store backups privately. Copy any model folders referenced through symlinks separately.
- **Recovery:** stop services, restore matching program and state backups and service definitions, then start Qdrant and Console (Console starts Caddy). Never combine one installation's database with another's secrets. Retain the original customer ZIP and external release checksum.

Program files: `/opt/umbratic/veil-console`. Linux state: `/var/lib/veil-console`. Mac state: `/Library/Application Support/Umbratic/Veil Console/State`; shared models: `/Library/Application Support/Umbratic/Veil Console/Models`. Linux units are `umbratic-{qdrant,console}`. Mac definitions are `/Library/LaunchDaemons/com.umbratic.{qdrant,console}.plist`.

For an unclaimed installation whose setup code expired, run the installed `bin/veil-console --state-dir <canonical-state-path> --issue-setup-code` with sudo. It prints a fresh code only while the private managed Console is running; a claimed installation returns `claimed`.

Change the employee address, HTTPS port, and certificate mode under **Connection** on the main Veil page. Applying briefly interrupts employee connections. Update existing devices to the new address and issue new codes for pending invitations; certificate-mode changes may require re-enrollment.
