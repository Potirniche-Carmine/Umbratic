# Enterprise Licensing

Run these commands from the Umbratic repository root on the release-signing
computer.

## 1. Create the signing key

Create this key once:

```sh
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-entitlement-signing.key" && chmod 600 "$HOME/umbratic-entitlement-signing.key"
```

Keep the key outside the repository and customer release. Keep a protected
backup. Do not copy it to the customer server.

## 2. Create the customer release

Set the version, seat limit, and device limit in this command:

```sh
npm run veil-console:release -- --version 0.0.1 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

The signed release appears in `artifacts/releases/`.

## 3. Install the customer release

Copy the zip to the Ubuntu server. Do not copy the signing key.

```sh
cd /tmp
unzip umbratic-veil-console-0.0.1-linux-amd64.zip
cd umbratic-veil-console-0.0.1-linux-amd64
sha256sum -c SHA256SUMS
sudo ./install.sh --dnsname console.example.com
```

The installer puts the binaries and signed entitlement in
`/opt/umbratic/veil-console`. Writable state stays in `/var/lib/veil-console`.
Remove the zip and extracted directory from `/tmp` after installation.

Read the one-time owner setup code:

```sh
sudo cat /run/veil-console/setup-code
```

Open `https://console.example.com:8432/setup`.

## 4. Reissue or change limits

Read `org_uid` from the existing `entitlement.json`. Use the same organization
UID and signing key:

```sh
npm run veil-console:release -- --version 0.0.2 --seats 40 --devices-per-user 2 --org-uid org_EXISTING_VALUE --signing-key-file "$HOME/umbratic-entitlement-signing.key"
```

Install the new binaries and new entitlement together. Keep the organization UID
unchanged so the existing identity store remains valid.

## Backup

Stop Veil Console and back up these files together:

- `/opt/umbratic/veil-console/entitlement.json`
- `/var/lib/veil-console/veil-identity.json`
- `/var/lib/veil-console/console.db`
- `/var/lib/veil-console/secrets.json`
- The Veil and Veil Console binaries

## Local WSL test

Create a release with version `0.0.1-local`. Then run:

```sh
unzip artifacts/releases/umbratic-veil-console-0.0.1-local-linux-amd64.zip -d "$HOME"
chmod 700 "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/veil" "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/veil-console"
chmod 600 "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/entitlement.json"
"$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/veil-console" --listen 127.0.0.1 --port 8177 --state-dir "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/state" --veil-binary "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/veil" --veil-address 127.0.0.1:8080 --entitlement "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64/entitlement.json"
```

Open `http://127.0.0.1:8177/setup`. Stop the test with `Ctrl+C`. Remove it with:

```sh
rm -rf -- "$HOME/umbratic-veil-console-0.0.1-local-linux-amd64"
```
