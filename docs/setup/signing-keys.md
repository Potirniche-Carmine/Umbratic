# Signing keys

Two keys. Create them once, on the release-signing computer, and never again.

**Which computer that is:** the Ubuntu or Ubuntu WSL machine where you build
customer Veil bundles. Not the Mac or the Windows PC that build the desktop
app — those need only their own `release.env`
([release-machine.md](release-machine.md)) and never read these files. Keep
both keys in that one place; every extra copy is another thing that can leak.

## Create them

```bash
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-entitlement-signing.key" && chmod 600 "$HOME/umbratic-entitlement-signing.key"
```

```bash
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-feed-master.key" && chmod 600 "$HOME/umbratic-feed-master.key"
```

## What each one is for

| Key | Used by | If you lose it |
| --- | --- | --- |
| `umbratic-entitlement-signing.key` | Signs each customer's `entitlement.json` — their seat count, device limit, search allowance | Every customer needs a new release |
| `umbratic-feed-master.key` | Each customer's app-update key is derived from it | Every customer needs a new Veil build |

## Rules

1. Back both up offline, somewhere protected.
2. Never commit them.
3. Never put either on a customer's server.
4. Never run the commands above a second time. If a key genuinely has to reach
   another machine, copy the file and check it arrived byte for byte
   (`cmp a b`). A regenerated feed key does not announce itself — it just makes
   every token your Veil mints stop verifying.

## No, you do not make new ones per customer

These two keys are your company's, and there is one of each for as long as
Umbratic exists. A customer never gets either. Building their release reads
these files on your machine and compiles **derived** values into their `veil`
binary:

| Stamped into their binary | What it is | What it can do |
| --- | --- | --- |
| `TrustedPublicKey` | The public half of the entitlement key | Check their entitlement. It cannot forge one, even with root on their server. |
| `CustomerKey` | `HMAC(feed master key, their org UID)` | Mint update tokens for them, and nobody else |
| `SubscriptionKey` | The Brave key, if they bought search | Buy searches on our plan |

So each customer's release is different, but no key is ever generated again.
The feed key in particular is derived and never stored anywhere, which is why
there is no customer list to keep in sync in Cloudflare, and why a key taken
off one customer's server reveals neither the master key nor any other
customer's.

## Why the command looks like that

`umask 077` is doing real work: the `>` redirect creates the file, so the mask
decides its permissions at the moment it exists. Under a normal `022` default
it would be created world-readable, and anything on the machine could read the
key in the window before `chmod` runs.

`tr '+/' '-_'` and `tr -d '=\n'` turn OpenSSL's base64 into unpadded
base64url. That is not cosmetic — Go reads both keys with
`base64.RawURLEncoding`, and the update Worker with its own decoder. Each file
must be exactly 43 characters with no trailing newline. One stray character and
it silently stops matching, with no error that says so.

Next: [update-feed.md](update-feed.md) uses the feed key to set up the Worker.
