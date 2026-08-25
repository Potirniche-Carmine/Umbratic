# Running a customer's server

Everything you do after [deploy-customer.md](deploy-customer.md).

## Day to day

```bash
sudo systemctl restart veil-console
```

```bash
sudo systemctl status veil-console --no-pager
```

```bash
sudo journalctl -u veil-console -n 100 --no-pager
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

Restarting Console also restarts the Veil process it supervises. Veil sessions
live in memory, so desktop apps create new ones after a restart.

Use Console → **Access** to deactivate or reactivate users, revoke devices, and
issue replacement enrollment codes.

## Change seats, devices, or search allowance

1. Read their org UID from `/opt/umbratic/veil-console/entitlement.json`.
2. Build a new release with the **same** org UID:
   ```bash
   npm run veil-console:release -- --version 0.2.0 --seats 40 --devices-per-user 2 --org-uid org_EXISTING_VALUE --signing-key-file "$HOME/umbratic-entitlement-signing.key" --feed-key-file "$HOME/umbratic-feed-master.key"
   ```
3. Install it as in [upgrade](#upgrade).

**Never change the org UID.** The identity store belongs to it.

**Carry every limit forward on every release**, including
`--searches-per-month`. The entitlement is a complete statement of what the
organization bought, not a patch — a flag you leave off returns to its default,
and for web search that default is off. The subscription key needs no carrying;
it comes from `release.env` on every build.

If a new limit is below current use, administration still works but product
access stops until an administrator deactivates users or revokes devices to fit.
A lowered search allowance behaves differently: the month's usage is already
counted, so an allowance below it simply leaves no searches for that month.

## Upgrade

1. Back up first (below).
2. Build the new release with the existing org UID.
3. Copy the zip to the server and verify `SHA256SUMS`.
4. Stop the service, then run the new installer:
   ```bash
   sudo systemctl stop veil-console
   ```
   ```bash
   sudo ./install.sh --dnsname veil.example.com
   ```

Use the same port options as the original install. Afterwards, confirm the
service, the Console tunnel, the Veil HTTPS address, and one desktop connection.

## Back up

```bash
sudo systemctl stop veil-console
```

Copy these together:

- `/opt/umbratic/veil-console/entitlement.json`
- `/opt/umbratic/veil-console/veil`
- `/opt/umbratic/veil-console/veil-console`
- `/var/lib/veil-console/veil-identity.json`
- `/var/lib/veil-console/console.db`
- `/var/lib/veil-console/secrets.json`
- `/etc/systemd/system/veil-console.service`
- `/etc/caddy/conf.d/veil-console.caddy`

```bash
sudo systemctl start veil-console
```

Take the entitlement, binaries, database, secrets, and identity store from the
same deployment — they belong together. Qdrant does not need to be in the
backup: after a restore, re-index from the Documents tab and the corpus rebuilds
from the stored originals.

Keep the signing-key backup somewhere else entirely, and never on this server.

## Recover

1. Install the same release on the replacement server.
2. `sudo systemctl stop veil-console`
3. Restore the backed-up files to their original paths and permissions.
4. `sudo systemctl daemon-reload`
5. Validate Caddy.
6. Start `veil-console` and reload Caddy.
7. Repeat the checks in [deploy-customer.md](deploy-customer.md#8-verify).

## Cut them off from updates

See [../setup/update-feed.md](../setup/update-feed.md#cut-a-customer-off).

Full path list: [../reference/storage.md](../reference/storage.md).
