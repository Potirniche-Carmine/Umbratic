# The update feed

Installed apps update from `https://downloads.umbratic.ai`. A Cloudflare Worker
is the only route to the release bucket, and it serves a request only when the
request carries a current update token.

A token is minted by a customer's own Veil, offline, and collected by their
desktop apps whenever they open a session. Veil holds one key,
`HMAC(master key, org UID)`, stamped into its binary when the customer release
is built. The Worker derives the same key to check a token, so there is no
customer list to keep in sync anywhere. Tokens are accepted for thirty days
after they are minted; a company that stops running Veil stops receiving
updates without anyone doing anything.

Nothing about this is visible in the app. Nobody types a key.

## One-time setup

### 1. The master key

On the release-signing computer, next to the entitlement signing key:

```bash
umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$HOME/umbratic-feed-master.key" && chmod 600 "$HOME/umbratic-feed-master.key"
```

Keep a protected offline backup. If this key is lost, every customer needs a
new Veil build. Do not put it on a customer server.

### 2. The bucket

Cloudflare dashboard → **R2 Object Storage** → **Create bucket** →
`umbratic-downloads`, location Automatic. Leave it private: do **not** connect a
custom domain and do **not** enable public access. The Worker reaches it
through a binding.

### 3. The revocation list

**Storage & Databases → KV → Create namespace** → `umbratic-revoked`. Put its
ID — the 32-character hex string, not the name — into `id` in
`infrastructure/downloads-worker/wrangler.toml`, then commit that change:

```bash
npx wrangler kv namespace list
```

### 4. The Worker

From `infrastructure/downloads-worker`:

```bash
npx wrangler secret put FEED_MASTER_KEY
```

Paste the contents of `~/umbratic-feed-master.key` when prompted, then deploy:

```bash
npx wrangler deploy
```

The first deploy creates the `downloads.umbratic.ai` custom domain and its
certificate. Wait until the dashboard shows it Active.

### 5. Release credentials

`~/.umbratic/release.env` on each release machine still holds the R2 API token
that `npm run publish:release` uploads with. Create it under **Manage R2 API
Tokens** with **Object Read & Write** on `umbratic-downloads` only. Publishing
uses the S3 API directly and does not go through the Worker.

## Per customer

Building a customer release derives their key and stamps it into their Veil:

```bash
npm run veil-console:release -- --version 0.1.0 --seats 30 --devices-per-user 2 --signing-key-file "$HOME/umbratic-entitlement-signing.key" --feed-key-file "$HOME/umbratic-feed-master.key"
```

Nothing else to do. Their apps start receiving updates as soon as devices enroll.

Keep a note of each customer's org UID — it is printed in the entitlement and
shown in Veil Console. Revoking needs it.

## When a customer leaves

```bash
npx wrangler kv key put --namespace-id=<namespace id> --remote org_xxxxxxxx 1
```

Every update check from that company is refused from the next check onward,
whatever runs on their side. Installed apps keep working at the version they
have; Veil keeps working under the entitlement it was built with. To undo:

```bash
npx wrangler kv key delete --namespace-id=<namespace id> --remote org_xxxxxxxx
```

## What this does and does not do

It decides who may download a release. It is not what makes a release safe to
install — code signing is, and the updater verifies it after the download.

An enrolled employee can read the token out of their own machine. It buys them
release downloads for at most thirty days, tells them nothing about any other
company, and reveals neither the customer key nor the master key.
