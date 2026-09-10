# Umbratic server quickstart

You need the customer ZIP for your server, the supplied model folders, and administrator access. The server starts with local access only. After owner setup, choose the employee-facing address in Console. Console and model ports stay private.

1. **Unzip and deploy.** Verify the ZIP against the checksum supplied by Umbratic through your release channel. Open a terminal in the extracted folder and run:

   ```sh
   sudo ./deploy.sh
   ```

   Wait for “Veil and Console are running.” If deployment stops, follow its error instruction and rerun the same command. Do not edit the signed entitlement or package files.

   On Mac, server programs, state, models, logs and backups live together in `/Library/Application Support/Umbratic/Veil Console/`. An existing `/opt/umbratic/` installation moves there automatically after the new services pass their checks. Your model files, owner account, employee registrations and certificates are preserved. The desktop keeps personal data separately in `~/Library/Application Support/Umbratic/`.

2. **Open Console.** Use the Console address printed by deployment. For a remote server, first open a tunnel from your computer:

   ```sh
   ssh -N -L 8177:127.0.0.1:8177 USER@SERVER
   ```

3. **Create the owner account.** Enter the administrator setup code printed on the last line, then choose your username and a password of at least 15 characters. The code expires after 15 minutes and works once.

4. **Set the connection.** On the main **Veil** page, use **Connection** to enter the server’s VPN IPv4 address or hostname and HTTPS port (default: **8432**). Keep **Private / VPN** certificates for private networks. Click **Apply** and allow employee computers to reach that port through the VPN/firewall. `localhost` permits access only from the server itself. For **Public domain** certificates, DNS must point to the server and public TCP port 443 must forward to the configured HTTPS port for certificate validation and renewal; [Caddy uses TLS-ALPN validation](https://caddyserver.com/docs/automatic-https). The settings and certificate identity survive restarts and redeployment. If applying fails, Console attempts to restore the previous connection.

5. **Add your models.** In **Models**, click **Open models folder**, copy your model folders there in Finder or your Linux file manager, then click **Refresh folders**. Console lists the models it detects. For Hugging Face, copy the whole folder for that model, including `blobs` and `snapshots`. On a headless server, copy models to `/var/lib/umbratic-models`. Choose **Chat**, **Dictation**, or **Embedding**, select **Choose a model**, then **Add model**. Chat uses one model name for both the picker and API requests; it defaults to the folder name. Dictation converts speech to text and automatically adds `-Dictation` to the name (for example, `Qwen0.6B-Dictation`). Embedding creates document-search vectors and adds `-Embedding`. These two roles use automatic serving settings and the checkpoint's native context. For chat, review or edit the command on its card. Press **Start**; status and startup logs update automatically. Chat starts with a 16,384-token context; `--max-model-len` controls the serving limit. A larger window also needs enough cache memory. On the tested 48 GB Mac, the supplied Qwen3.8 27B 4-bit model started at 65,536 tokens with `--gpu-memory-utilization 0.60` and `--additional-config '{"turboquant": true, "k_quant": "q8_0", "v_quant": "q8_0"}'`. This uses vLLM Metal's experimental 8-bit cache. Verify long-prompt latency before adopting it for other machines. Start the models you need and choose the default chat model. Chat works without dictation or embeddings. For company documents, start an embedding model and enable retrieval on **Documents**.

   On each chat model, enable the **Reasoning options** employees may choose: **On**, **Off**, **Low**, **Medium**, **High**, **Xhigh**, and **Max**. Custom levels cannot be added. Enable only options supported by that checkpoint. The supplied Qwen3.8 model supports **On**, **Off**, **Low**, **Medium**, and **Xhigh**; On uses its default thinking depth. **Sampling settings** contains `thinking` and `non_thinking` profiles; Off selects the latter. Veil sends these parameters to the runtime on each request, so they belong here rather than in the harness or startup command. Local Qwen3.8 checkpoints receive the [published Qwen profiles](https://huggingface.co/Qwen/Qwen3.8-27B#best-practices) automatically: thinking uses temperature 1.0, top_p 0.95, top_k 20, min_p 0.0, presence_penalty 0.0, and repetition_penalty 1.0; non-thinking uses 0.7, 0.80, 20, 0.0, 1.5, and 1.0 respectively. Other checkpoints use server defaults unless profiles are supplied.

6. **Add employees.** In **Access**, add each employee and issue an enrollment code. The page shows assigned and purchased seats. Deactivating a user frees their seat; revoking a device does not.

7. **Connect Umbratic.** Give each employee the Veil HTTPS address shown on the main page and their own enrollment code. They enter both in Umbratic. Enrollment codes are separate from the administrator setup code and work once.

For private/local HTTPS, the enrollment code includes the server's trust certificate. Use the supplied updated Umbratic app and paste the full code; no Keychain import is needed. Use the exact address shown in Console. After changing it, update employee devices and issue new enrollment codes for pending invitations. Changing certificate mode may require re-enrollment. Public company hostnames use automatically managed certificates. `localhost` works only on the server computer.

To restart the installation, use Console's **Restart** control. Enabled models are restored when the Console service restarts. On a Mac with FileVault, unlock the disk after a reboot. Keep a current backup before redeploying the ZIP.

For a fresh test installation, `sudo ./deploy.sh --clean` removes the existing Console owner, users, documents, models, and private state before reinstalling. Use ordinary `sudo ./deploy.sh` to preserve an installation.
