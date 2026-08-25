# Deploying a customer

Build one customer's release, install it on their server, enroll their people.

To rehearse this on your own machine first, see
[test-locally.md](test-locally.md).

## What you need

**On the release computer:** the repository, Node.js, npm, Go, OpenSSL. Ubuntu
or Ubuntu WSL. Both keys from [../setup/signing-keys.md](../setup/signing-keys.md).

**On the customer's side:**

- An Ubuntu 24.04 LTS `amd64` server, with SSH access.
- A DNS name for Veil, such as `veil.example.com`.
- Caddy, from its supported Ubuntu package.
- vLLM installed, so Console can launch each managed model.
- A company VPN, or a list of approved desktop IP addresses.

Never put the entitlement signing key on the customer's server.

## 1. Build their release

```bash
npm run veil-console:release -- --version 0.1.0 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key" --feed-key-file "$HOME/umbratic-feed-master.key"
```

Add `--searches-per-month 20000` if they bought web search.

The release lands at
`artifacts/releases/umbratic-veil-console-0.1.0-linux-amd64.zip` and contains
the Veil and Console binaries, a signed `entitlement.json`, the installer, and
`SHA256SUMS`.

Write down the org UID it prints. You need it to change their limits later, or
to cut them off from updates.

## 2. Open the right ports

| Port | Purpose | Who reaches it |
| --- | --- | --- |
| `8432/TCP` | Veil HTTPS for desktop apps | Company VPN or approved desktop IPs only |
| `22/TCP` | SSH, and the Console tunnel | Admin VPN or approved admin IPs only |
| `8177/TCP` | Veil Console | Nobody. Loopback only. |
| `8080/TCP` | Raw Veil | Nobody. Loopback only. |
| vLLM model ports | Model runtimes | Nobody. Loopback only. |

Apply the same rules in the host firewall **and** the cloud firewall or
security group. Do not publish a private port through NAT or a container port
map.

Ports `80` and `443` may be needed while Caddy gets or renews its certificate.
A DNS challenge removes that.

To serve Veil on `443` instead of `8432`, add `--port 443` to `install.sh` in
step 4. The desktop URL is then `https://veil.example.com`.

## 3. Prepare the server

1. Create the DNS record.
2. Install Caddy.
3. Install vLLM.
4. Apply the port rules above.
5. Copy the release zip to `/tmp`.

## 4. Install

```bash
cd /tmp
unzip umbratic-veil-console-0.1.0-linux-amd64.zip
cd umbratic-veil-console-0.1.0-linux-amd64
sha256sum -c SHA256SUMS
sudo ./install.sh --dnsname veil.example.com
```

The installer creates the `veil-console` account, installs to
`/opt/umbratic/veil-console`, puts state in `/var/lib/veil-console`, adds the
systemd service and the Caddy route, and starts Console.

It does not install a model runtime or change firewall rules.

Delete the zip and extracted directory from `/tmp` afterwards.

The desktop Veil URL is `https://veil.example.com:8432`.

## 5. Create the Console owner

Read the setup code — it expires in 15 minutes:

```bash
sudo cat /run/veil-console/setup-code
```

From your own computer, open a tunnel and leave it running:

```bash
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

Open `http://127.0.0.1:8177/setup`, enter the code, and create the owner with a
password of at least 15 characters. There is one owner account.

Later administration uses the same tunnel and `http://127.0.0.1:8177`.

## 6. Start a model

Add `--vllm-binary /path/to/vllm` to the `veil-console` systemd unit's
`ExecStart` line and restart the service. vLLM downloads each model's weights
itself on first start.

Then in Console:

1. **Models** → add one from the catalog, or **Custom** for a reviewed
   repository the catalog does not list.
2. **Start** on its card. Wait for it to report running.
3. Make it the default from its card.
4. **Settings** → review the serving limits → **Apply and restart**.
5. Check that Overview shows Veil running.

Each managed model is its own vLLM process on its own loopback port, with its
own weights and KV cache in GPU memory. Veil and Console do not accept a
model-provider API key.

## 7. Enroll people

In Console:

1. **Access** → create an assigned user.
2. Create an Enrollment code for them.
3. Send them the Veil HTTPS URL and the code, over a channel they already
   trust.

On their desktop app:

1. **Settings** → **Connection**.
2. **Company server**.
3. Enter the URL and the Enrollment code.
4. **Save & connect**.

A code is valid for 24 hours and works once. Creating a new one revokes that
user's previous pending code.

## 8. Verify

On the server:

```bash
sudo systemctl status veil-console --no-pager
sudo systemctl status caddy --no-pager
curl --fail http://127.0.0.1:8177/healthz
```

Confirm the control API is not public — this must return `404`:

```bash
curl -i https://veil.example.com:8432/api/control/access
```

Then check that port `8177` is unreachable without the tunnel, port `8080` is
unreachable remotely, the model port is not public, and one desktop can enroll
and start a chat.

## Web search, if they bought it

Two things turn it on, and both are needed:

| Input | Where it comes from |
| --- | --- |
| `--searches-per-month N` | The release command in step 1. Default `0`. |
| Brave subscription key | `UMBRATIC_BRAVE_SEARCH_API_KEY` in `~/.umbratic/release.env` |

- Leave either one out and the release is a complete product with no web
  search.
- The allowance is a whole-organization pool, not per seat. Sales search many
  times a day and engineers barely at all, so size it for the organization.
- Searches leave the customer's server, not the user's machine.
- When the pool is spent the assistant says so and stops searching. Everything
  else keeps working. It resets on the first day of the next UTC month.
- To raise it mid-month, issue a new release
  ([operate-server.md](operate-server.md#change-seats-devices-or-search-allowance)).

The allowance is what this customer bought, so it is a release flag. The
subscription key is ours — it buys searches on our credit plan and is the same
in every bundle — so it lives on the release machine instead. It is baked into
that customer's `veil` binary at build time, never written into the zip, never
listed in `SHA256SUMS`, never stored on their server.

## How it fits together

```text
Administrator browser
  -> SSH tunnel
  -> Veil Console 127.0.0.1:8177

Desktop application
  -> restricted HTTPS Caddy :8432
  -> Veil 127.0.0.1:8080
  -> managed vLLM processes on loopback ports
```

Console has no public endpoint. Caddy returns `404` for `/api/control` and
everything below it, so only Console can use the Veil control API.

The entitlement sets the organization, user limit, device limit, and monthly
search allowance. It does not expire, and assigned users stay active until an
administrator deactivates them.
