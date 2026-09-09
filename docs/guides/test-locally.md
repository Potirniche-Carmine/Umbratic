# Testing on your own machine

Run a real Veil on your own PC, connect your desktop app to it, and watch the
whole update path work — without a customer, a server, or a domain.

Works on Ubuntu WSL. Others on your network can connect too.

## 1. Build a local customer release

Follow the [release setup](release-server.md), then run:

```sh
npm run veil-console:release -- --customer local-test --version 0.1.0-local --seats 5
```

## 2. Deploy it

Unzip the file from `artifacts/releases/` and run `sudo ./deploy.sh` inside the extracted folder. Follow the printed Console address and setup code. Keep **Connection** on localhost for testing on the server itself, or enter the server’s VPN address for another computer.

## 3. Create the owner and enroll yourself

1. Open `http://127.0.0.1:8177/setup` and create the owner account.
2. **Access** → create a user → create an Enrollment code.
3. In the desktop app: **Settings** → **Connection** → **Company server**,
   enter the Veil URL and the code, **Save & connect**.

## 4. Watch the update path

Once connected, the app has an update token and checks the feed on its own — a
few minutes after launch, then every six hours. Nothing to press.

To see what it is doing, look for `updater.` entries in the app's diagnostics.

## What actually happens

**You must connect for this to work.** The app collects its update token when
it opens a Veil session, and it only opens sessions in server mode. Connecting
to a company server switches it into server mode, so connecting once is enough
— but an app that has only ever run local models has no token and, by design,
never contacts the feed at all.

**Then Veil can go away for a month.** The token is good for **30 days from the
moment Veil minted it**. Shut the WSL box down, unplug the PC, go offline —
updates keep working for the rest of those 30 days. Nothing is re-checked with
Veil, no key is exchanged per update check; the app just re-sends the token it
has, and the Worker re-derives the key to verify it.

**With Veil running normally it never expires.** Every session mints a fresh
30-day token, so ordinary use keeps rolling the window forward.

**Revocation is separate and immediate.** A KV entry blocks that org on its very
next check no matter how fresh the token is. Do not revoke and it simply works.

**The feed still needs internet.** Veil being local or offline is fine, but
`downloads.umbratic.ai` is on the internet and the app has to reach it.

## Letting friends connect

Their machines need to reach your Veil over HTTPS. On WSL2 that is the hard
part, not Veil: WSL sits behind its own NAT, so you need a port forward from
the Windows host to the WSL instance, and a firewall rule for it.

Each person needs their own enrollment code from Console. The seat and
device-per-user limits from step 1 apply.

## What you cannot test yet

An **unsigned build will not install.** The app fetches the channel file,
downloads the installer, checks the signature, and discards it. So this
rehearses mint → collect → serve → download, and stops one step short of
installing, until real certificates exist
([../setup/release-machine.md](../setup/release-machine.md)).

To test against the feed before certificates exist, publish with:

```bash
npm run publish:release -- --allow-unsigned
```
