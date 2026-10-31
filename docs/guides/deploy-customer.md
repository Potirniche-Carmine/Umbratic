# Self-host Umbratic

Build the target-specific server ZIP from source using the [server release guide](release-server.md). You need a supported server, administrator access, and model files you are licensed to use. The release build creates the signed entitlement and package metadata for your deployment; you manage its signing key and configured user limit. The server starts with local access only. After owner setup, choose the employee-facing address in Console. Console and model ports stay private.

1. **Unzip and deploy.** Verify the ZIP against the checksum from your build or trusted release channel. Open a terminal in the extracted folder and run:

   ```sh
   sudo ./deploy.sh
   ```

   Wait for “Veil and Console are running.” If deployment stops, follow its error instruction and rerun the same command. Regenerate signed package files through the release build when changing deployment limits.

   On Mac, server programs, state, models, logs and backups live together in `/Library/Application Support/Umbratic/Veil Console/`. An existing `/opt/umbratic/` installation moves there automatically after the new services pass their checks. Your model files, owner account, employee registrations and certificates are preserved. The desktop keeps personal data separately in `~/Library/Application Support/Umbratic/`.

2. **Open Console.** Use the Console address printed by deployment. For a remote server, first open a tunnel from your computer:

   ```sh
   ssh -N -L 8177:127.0.0.1:8177 USER@SERVER
   ```

3. **Create the owner account.** Enter the administrator setup code printed on the last line, then choose your username and a password of at least 15 characters. The code expires after 15 minutes and works once.

4. **Set the connection.** On the main **Veil** page, use **Connection** to enter the server’s VPN IPv4 address or hostname and HTTPS port (default: **8432**). Keep **Private / VPN** certificates for private networks. Click **Apply** and allow employee computers to reach that port through the VPN/firewall. `localhost` permits access only from the server itself. For **Public domain** certificates, DNS must point to the server and public TCP port 443 must forward to the configured HTTPS port for certificate validation and renewal; [Caddy uses TLS-ALPN validation](https://caddyserver.com/docs/automatic-https). The settings and certificate identity survive restarts and redeployment. If applying fails, Console attempts to restore the previous connection.

5. **Add your models.** In **Models**, click **Open models folder**, copy your model folders there, then click **Refresh folders**. For Hugging Face, copy the complete cached model folder, including `blobs` and `snapshots`. On a headless Linux server, use `/var/lib/umbratic-models`.

   Choose **Chat**, **Dictation**, or **Embedding**, select the model, and click **Add model**. Review the chat model’s launch command, then press **Start**. The model’s context window and memory requirements must fit your hardware. Startup status and logs are available on its card. Start the models you need and choose the default chat model. Chat works without dictation or embedding models; document retrieval requires an embedding model and retrieval enabled on **Documents**.

   Enable only the **Reasoning options** supported by the checkpoint. Configure `thinking` and `non_thinking` profiles under **Sampling settings** according to the model’s documentation. Veil applies these server-owned settings to each request.

6. **Add employees.** In **Access**, add each employee and issue an enrollment code. The page shows assigned users and the seat limit configured in your signed deployment entitlement. Deactivating a user frees their seat; revoking a device does not.

7. **Connect Umbratic.** Give each employee the Veil HTTPS address shown on the main page and their own enrollment code. They enter both in Umbratic. Enrollment codes are separate from the administrator setup code and work once.

For private/local HTTPS, the enrollment code includes the server's trust certificate. Use the current Umbratic app and paste the full code; no Keychain import is needed. Use the exact address shown in Console. After changing it, update employee devices and issue new enrollment codes for pending invitations. Changing certificate mode may require re-enrollment. Public company hostnames use automatically managed certificates. `localhost` works only on the server computer.

To restart the installation, use Console's **Restart** control. Enabled models are restored when the Console service restarts. On a Mac with FileVault, unlock the disk after a reboot. Keep a current backup before redeploying the ZIP.

For a fresh test installation, `sudo ./deploy.sh --clean` removes the existing Console owner, users, documents, models, and private state before reinstalling. Use ordinary `sudo ./deploy.sh` to preserve an installation.

Umbratic does not collect usage analytics or automatically upload desktop telemetry. Veil and Console keep operational state, counters, audit records, and diagnostic logs on your server. As administrator, you are responsible for its access and retention policy.
