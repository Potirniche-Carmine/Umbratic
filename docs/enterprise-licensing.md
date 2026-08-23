# Enterprise Deployment

This guide covers one production deployment of Veil and Veil Console.

## Deployment design

Veil Console is for administrators. It listens only on the server loopback
address. It does not have a public endpoint.

The desktop application connects to Veil through restricted HTTPS:

```text
Administrator browser
  -> SSH tunnel
  -> Veil Console 127.0.0.1:8177

Desktop application
  -> restricted HTTPS Caddy :8432
  -> Veil 127.0.0.1:8080
  -> Ollama 127.0.0.1:11434 or vLLM 127.0.0.1:8000
```

Caddy returns `404` for `/api/control` and all paths below it. Only Console can
use the Veil control API.

## Before you start

Prepare these items:

- An Ubuntu 24.04 LTS `amd64` server.
- SSH access to the server.
- A DNS name for Veil, such as `veil.example.com`.
- Caddy from its supported Ubuntu package.
- Ollama or vLLM on the server or another private address.
- The exact model ID that the runtime reports.
- A company VPN or a list of approved desktop IP addresses.
- A protected release-signing computer with the repository, Node.js, npm, Go,
  OpenSSL, and standard Linux tools. Ubuntu or Ubuntu WSL is supported.

Do not put the entitlement signing key on the customer server.

## Network rules

Use these default rules:

| Port | Purpose | Remote access |
| --- | --- | --- |
| `8432/TCP` | Veil HTTPS for desktop applications | Allow only the company VPN or approved desktop IP addresses |
| `22/TCP` | SSH and the Console tunnel | Allow only administrator VPN or approved administrator IP addresses |
| `8177/TCP` | Veil Console | Do not allow; loopback only |
| `8080/TCP` | Raw Veil | Do not allow; loopback only |
| `11434/TCP` | Ollama | Do not allow unless a private runtime network requires it |
| `8000/TCP` | vLLM | Do not allow unless a private runtime network requires it |

Ports `80` and `443` can be necessary when Caddy gets or renews a public TLS
certificate. Allow them only as required for certificate validation. A DNS
challenge can remove this inbound requirement.

You can use port `443` for Veil instead of `8432`:

```sh
sudo ./install.sh --dnsname veil.example.com --port 443
```

When you use port `443`, the desktop Veil URL is
`https://veil.example.com`.

Apply the same rules in the host firewall and the cloud firewall or security
group. Do not publish a private port through NAT or a container port map.

## 1. Create the signing keys

Run these commands once on the release-signing computer:

```sh
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-entitlement-signing.key" && chmod 600 "$HOME/umbratic-entitlement-signing.key"
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-feed-master.key" && chmod 600 "$HOME/umbratic-feed-master.key"
```

The second key is the update feed's; a customer release derives this
organization's key from it so their desktop applications can download
application updates. See `docs/update-feed.md`.

Keep protected offline backups. Do not commit either key. Do not add them to a
customer release.

## 2. Create the customer release

Run this command from the repository root:

```sh
npm run veil-console:release -- --version 0.1.0 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key" --feed-key-file "$HOME/umbratic-feed-master.key"
```

The release appears at:

```text
artifacts/releases/umbratic-veil-console-0.1.0-linux-amd64.zip
```

The release contains:

- Veil and Veil Console Linux binaries.
- A signed `entitlement.json`.
- The installer and production configuration templates.
- `SHA256SUMS`.

The entitlement sets the organization, authorized-user limit, and device limit.
It does not expire. Assigned users stay active until an administrator
deactivates them.

## 3. Prepare the server

Before installation:

1. Create the DNS record for the Veil domain.
2. Install Caddy.
3. Install and start Ollama or vLLM.
4. Download the selected model.
5. Apply the network rules in this guide.
6. Copy the release zip to `/tmp` on the server.

Keep the model runtime on loopback when it runs on the same server.

## 4. Install Veil and Console

Run these commands on the server:

```sh
cd /tmp
unzip umbratic-veil-console-0.1.0-linux-amd64.zip
cd umbratic-veil-console-0.1.0-linux-amd64
sha256sum -c SHA256SUMS
sudo ./install.sh --dnsname veil.example.com
```

The default desktop Veil URL is:

```text
https://veil.example.com:8432
```

The installer:

- Creates the `veil-console` system account.
- Installs read-only files in `/opt/umbratic/veil-console`.
- Stores writable state in `/var/lib/veil-console`.
- Installs the `veil-console` systemd service.
- Adds the Caddy route for Veil.
- Starts Veil Console.

The installer does not install a model runtime or change firewall rules.

After a successful installation, remove the zip and extracted directory from
`/tmp`.

## 5. Create the Console owner

Read the one-time setup code:

```sh
sudo cat /run/veil-console/setup-code
```

The code expires after 15 minutes.

Start an SSH tunnel from the administrator computer:

```sh
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

Keep this command running. Open:

```text
http://127.0.0.1:8177/setup
```

Enter the setup code. Create the owner account with a password of at least 15
characters. Console supports one owner account.

For later administration, start the same SSH tunnel and open:

```text
http://127.0.0.1:8177
```

## 6. Configure the model runtime

In Console:

1. Select `Ollama` or `vLLM`.
2. Enter the private runtime URL.
3. Enter the exact model ID.
4. Select **Test connection**.
5. Select **Apply and restart**.
6. Confirm that the Overview page shows Veil as running.

The usual runtime URLs are:

- Ollama: `http://127.0.0.1:11434`
- vLLM: `http://127.0.0.1:8000`

Veil and Console do not accept a model-provider API key.

## 7. Enroll desktop users

In Console:

1. Open **Access**.
2. Create an assigned user.
3. Create an Enrollment code for that user.
4. Send the Veil HTTPS URL and Enrollment code to the user through an approved
   secure channel.

On the desktop application:

1. Open **Settings** and **Connection**.
2. Select **Company server**.
3. Enter the Veil HTTPS URL.
4. Enter the Enrollment code.
5. Select **Save & connect**.

An Enrollment code is valid for 24 hours and can be used once. Creating a new
code revokes the previous pending code for that user.

Use Console to deactivate or reactivate users, revoke devices, and create
replacement Enrollment codes.

## 8. Verify the deployment

On the server:

```sh
sudo systemctl status veil-console --no-pager
sudo systemctl status caddy --no-pager
curl --fail http://127.0.0.1:8177/healthz
```

From an approved desktop network, confirm that the Veil HTTPS address is
reachable.

Confirm that the control API is not public:

```sh
curl -i https://veil.example.com:8432/api/control/access
```

The expected status is `404`.

Also confirm:

- Port `8177` is not reachable without the SSH tunnel.
- Port `8080` is not remotely reachable.
- The model-runtime port is not publicly reachable.
- A desktop can enroll and start a chat.

## 9. Normal operations

Use these commands on the server:

```sh
sudo systemctl restart veil-console
sudo systemctl status veil-console --no-pager
sudo journalctl -u veil-console -n 100 --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile
```

Restarting Console also restarts its supervised Veil process. Veil sessions are
kept in memory, so desktop applications must create new sessions after a Veil
restart.

## 10. Change seat or device limits

Read `org_uid` from the installed entitlement:

```text
/opt/umbratic/veil-console/entitlement.json
```

Create a new release with the same organization UID and signing key:

```sh
npm run veil-console:release -- --version 0.2.0 --seats 40 --devices-per-user 2 --org-uid org_EXISTING_VALUE --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

Do not change the organization UID. The identity store belongs to that UID.

If a new limit is lower than current use, administration stays available, but
product access stops until an administrator deactivates users or revokes
devices to meet the new limit.

## 11. Upgrade an installed release

Before an upgrade:

1. Create a backup.
2. Use the existing organization UID.
3. Copy the new release zip to the server.
4. Verify `SHA256SUMS`.

Stop the service before you run the new installer:

```sh
sudo systemctl stop veil-console
sudo ./install.sh --dnsname veil.example.com
```

Use the same public and private port options as the original installation.
Confirm the service, Console tunnel, Veil HTTPS address, and one desktop
connection after the upgrade.

## 12. Backup and recovery

Stop Console before a backup:

```sh
sudo systemctl stop veil-console
```

Back up these items together:

- `/opt/umbratic/veil-console/entitlement.json`
- `/opt/umbratic/veil-console/veil`
- `/opt/umbratic/veil-console/veil-console`
- `/var/lib/veil-console/veil-identity.json`
- `/var/lib/veil-console/console.db`
- `/var/lib/veil-console/secrets.json`
- `/etc/systemd/system/veil-console.service`
- `/etc/caddy/conf.d/veil-console.caddy`

Start Console after the backup:

```sh
sudo systemctl start veil-console
```

Keep the entitlement, binaries, Console database, secrets, and identity store
from the same deployment. Keep the signing-key backup separately and never put
it on the production server.

To recover:

1. Install the same release on the replacement server.
2. Stop `veil-console`.
3. Restore the backed-up files to their original paths and permissions.
4. Run `sudo systemctl daemon-reload`.
5. Validate Caddy.
6. Start `veil-console` and reload Caddy.
7. Repeat the deployment checks.

## Optional local WSL test

Create a release with version `0.1.0-local`. Then run:

```sh
unzip artifacts/releases/umbratic-veil-console-0.1.0-local-linux-amd64.zip -d "$HOME"
chmod 700 "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/veil" "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/veil-console"
chmod 600 "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/entitlement.json"
"$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/veil-console" --listen 127.0.0.1 --port 8177 --state-dir "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/state" --veil-binary "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/veil" --veil-address 127.0.0.1:8080 --entitlement "$HOME/umbratic-veil-console-0.1.0-local-linux-amd64/entitlement.json"
```

Open `http://127.0.0.1:8177/setup`. Stop the test with `Ctrl+C`.
