# Umbratic server quickstart

You need the customer ZIP for your server, the supplied model folders, and administrator access. The server starts with local access only. After owner setup, choose the employee-facing address in Console. Console and model ports stay private.

1. **Unzip and deploy.** Verify the ZIP against the checksum supplied by Umbratic through your release channel. Open a terminal in the extracted folder and run:

   ```sh
   sudo ./deploy.sh
   ```

   Wait for “Veil and Console are running.” If deployment stops, follow its error instruction and rerun the same command. Do not edit the signed entitlement or package files.

2. **Open Console.** Use the Console address printed by deployment. For a remote server, first open a tunnel from your computer:

   ```sh
   ssh -N -L 8177:127.0.0.1:8177 USER@SERVER
   ```

3. **Create the owner account.** Enter the administrator setup code printed on the last line, then choose your username and a password of at least 15 characters. The code expires after 15 minutes and works once.

4. **Set the connection.** On the main **Veil** page, use **Connection** to enter the server’s VPN IPv4 address or hostname and HTTPS port (default: **8432**). Keep **Private / VPN** certificates for private networks. Click **Apply** and allow employee computers to reach that port through the VPN/firewall. `localhost` permits access only from the server itself. For **Public domain** certificates, DNS must point to the server and public TCP port 443 must forward to the configured HTTPS port for certificate validation and renewal; [Caddy uses TLS-ALPN validation](https://caddyserver.com/docs/automatic-https). The settings and certificate identity survive restarts and redeployment. If applying fails, Console attempts to restore the previous connection.

5. **Add your models.** In **Models**, upload a complete supplied model folder, or copy it to the models directory shown there. Choose **Chat**, **Dictation**, or **Embedding**, select **Choose a model**, then **Add model**. Review or edit the command on its card and press **Start**. On a 48 GB Mac, start the supplied 27B 4-bit model with the default 16,384-token context. If startup reports insufficient cache memory, reduce `--max-model-len`. Start the models you need and choose the default chat model. Chat works without dictation or embeddings. For company documents, start an embedding model and enable retrieval on **Documents**.

   On each chat model, enable the **Reasoning options** employees may choose. Add names such as `xhigh` under **Other levels** only when the model supports them. The supplied Qwen model supports **Off**, **Low**, **Medium**, and **Xhigh**. **Sampling settings** accepts two profiles, `thinking` and `non_thinking`; selecting Off applies the latter. Leave this blank to use the server defaults.

6. **Add employees.** In **Access**, add each employee and issue an enrollment code. The page shows assigned and purchased seats. Deactivating a user frees their seat; revoking a device does not.

7. **Connect Umbratic.** Give each employee the Veil HTTPS address shown on the main page and their own enrollment code. They enter both in Umbratic. Enrollment codes are separate from the administrator setup code and work once.

For private/local HTTPS, the enrollment code includes the server's trust certificate. Use the supplied updated Umbratic app and paste the full code; no Keychain import is needed. Use the exact address shown in Console. After changing it, update employee devices and issue new enrollment codes for pending invitations. Changing certificate mode may require re-enrollment. Public company hostnames use automatically managed certificates. `localhost` works only on the server computer.

To restart the installation, use Console's **Restart** control. Enabled models are restored when the Console service restarts. On a Mac with FileVault, unlock the disk after a reboot. Keep a current backup before redeploying the ZIP.

For a fresh test installation, `sudo ./deploy.sh --clean` removes the existing Console owner, users, documents, models, and private state before reinstalling. Use ordinary `sudo ./deploy.sh` to preserve an installation.
