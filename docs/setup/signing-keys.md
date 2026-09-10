# Release keys

Keep release files in the repository's ignored `artifacts/release-work/` on Mac, or `~/umbratic-release/` on Linux.

| File | What to do |
| --- | --- |
| `umbratic-feed-master.key` | Put your existing feed master key here. Use the same key as the update Worker. |
| `umbratic-entitlement-signing.key` | The release command creates this once if missing. If you already have one elsewhere, use that original file. |

The customer’s update key is derived automatically during ZIP creation. You do not create or copy a key per customer.

Back up both release keys privately. Never replace them, commit them, or send them to customers. The signing key is created with owner-only permissions; keep the master key owner-only too (`chmod 600 artifacts/release-work/*.key` from the repository root on Mac).

Next: [build a customer ZIP](../guides/release-server.md) or [configure the update feed](update-feed.md).
