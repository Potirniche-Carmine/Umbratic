# The update feed

Installed apps update from `https://downloads.umbratic.ai`. A Cloudflare Worker
is the only route to the release bucket, and it serves a request only when that
request carries a current update token.

Do this once. You need `umbratic-feed-master.key` from
[signing-keys.md](signing-keys.md).

## 1. Create the bucket

Cloudflare dashboard → **R2 Object Storage** → **Create bucket** →
`umbratic-downloads`, location Automatic.

Leave it private. Do **not** connect a custom domain and do **not** enable
public access — the Worker reaches it through a binding.

## 2. Create the revocation list

**Storage & Databases → KV → Create namespace** → `umbratic-revoked`.

Get its ID — the 32-character hex string, not the name:

```bash
npx wrangler kv namespace list
```

Put that ID into `id` in `infrastructure/downloads-worker/wrangler.toml` and
commit the change.

## 3. Upload the master key

From `infrastructure/downloads-worker`:

```bash
npx wrangler secret put FEED_MASTER_KEY < "$HOME/umbratic-release/umbratic-feed-master.key"
```

Pipe the file in. Do not paste at the prompt — the prompt masks what it
receives, so a paste that picks up one stray character sets a key that is
wrong in a way nothing reports until a customer's download is refused.

## 4. Deploy the Worker

```bash
npx wrangler deploy
```

The first deploy creates the `downloads.umbratic.ai` custom domain and its
certificate. Wait until the dashboard shows it Active.

## 5. Check it works

Mint a test token and ask the feed for something:

```bash
python3 -c "
import base64, hashlib, hmac, os, time
m = open(os.path.expanduser('~/umbratic-release/umbratic-feed-master.key')).read().strip()
d = lambda t: base64.urlsafe_b64decode(t + '=' * (-len(t) % 4))
b = lambda x: base64.urlsafe_b64encode(x).decode().rstrip('=')
org, stamp = 'org_testfeed', str(int(time.time()))
ck = hmac.new(d(m), org.encode(), hashlib.sha256).digest()
print(f\"{org}.{stamp}.{b(hmac.new(ck, f'{org}.{stamp}'.encode(), hashlib.sha256).digest())}\")
"
```

```bash
curl -A 'Umbratic/0.0.4 (darwin; arm64)' -H "X-Umbratic-Update-Token: <token>" https://downloads.umbratic.ai/releases/latest-mac.yml
```

You should get the channel file. Without the token you should get `403`.

The `-A` matters: if you have the WAF User-Agent rule on, a plain curl gets
Cloudflare's block page instead of the Worker.

## Cut a customer off

Use their org UID — it is printed in the entitlement and shown in Veil Console.

```bash
npx wrangler kv key put --namespace-id=<namespace id> --remote org_xxxxxxxx 1
```

Every update check from that company is refused from the next check onward.
Installed apps keep working at the version they have; Veil keeps working under
the entitlement it was built with.

To undo:

```bash
npx wrangler kv key delete --namespace-id=<namespace id> --remote org_xxxxxxxx
```

## Why it's like this

A token is `org_uid.unix_seconds.signature`, minted by that company's own Veil
and collected by their desktop apps whenever they open a session. Veil holds
one key, `HMAC(master key, org UID)`, stamped into its binary when the customer
release is built. The Worker derives the same key to check a token, so there is
no customer list to keep in sync anywhere.

Tokens are accepted for thirty days after minting, so a company that stops
running Veil stops receiving updates on its own. Revocation is the immediate
version of that. Nobody types a key; none of this is visible in the app.

This decides **who may download** a release. It is not what makes a release
safe to install — code signing is, and the updater verifies it after the
download.

An enrolled employee can read the token off their own machine. It buys them
release downloads for at most thirty days, tells them nothing about any other
company, and reveals neither the customer key nor the master key.
