# Ubuntu 24.04 LTS smoke test

Run this test on Ubuntu 24.04 LTS `amd64`. Use a clean clone and a test-only model runtime. Do not open port `8177` in a firewall or cloud security group.

## Build and start

```sh
cd infrastructure/veil-console
go test -race ./...
go vet ./...
bash ./scripts/smoke-wsl.sh
```

Keep the smoke launcher active. In a second Ubuntu terminal, run:

```sh
ss -ltnp | grep '127.0.0.1:8177'
if ss -ltnp | grep -E '0\.0\.0\.0:8177|\[::\]:8177'; then exit 1; fi
curl --fail --silent --show-error http://127.0.0.1:8177/healthz
```

The launcher builds a deterministic fake vLLM runtime at `http://127.0.0.1:18000`. Complete these browser checks:

The launcher also builds `smoke-client` in the printed smoke directory. You can use it to run the HTTP flow with the printed setup code:

```sh
/tmp/<printed-directory>/smoke-client <setup-code> /tmp/<printed-directory>/state
```

To verify restart persistence, keep a copy of the state directory and start the launcher with that path:

```sh
bash ./scripts/smoke-wsl.sh /tmp/veil-console-persisted-state
/tmp/<new-printed-directory>/smoke-client --verify-persist
```

1. Read the setup code from the controlling terminal. Create the owner with a password of at least 15 characters.
2. Sign out and sign in.
3. Configure vLLM, `http://127.0.0.1:18000`, and `fake-model`. Test and apply the settings.
4. Save the Veil client token from its one-time response.
5. Confirm that Veil becomes healthy. Restart it and confirm that it becomes healthy again.
6. Apply an invalid provider address. Confirm that the known-good Veil process stays healthy.
7. Remove the `csrf` field from a captured POST. Confirm an HTTP 403 response.
8. Send repeated wrong passwords. Confirm an HTTP 429 response with `Retry-After`.
9. Restart Console. Confirm that the owner, session state, and known-good configuration persist.
10. Search `console.log`, HTTP captures, SQLite text views, and audit rows for seeded token values. Confirm that they are absent, except for the explicit one-time token response.

## Remote and systemd checks

Install `deploy/veil-console.service` with reviewed local paths and the dedicated `veil-console` account. Then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now veil-console
sudo systemctl reboot
sudo systemctl status veil-console --no-pager
sudo -u veil-console test -r /var/lib/veil-console/console.db
stat -c '%U %G %a %n' /var/lib/veil-console /var/lib/veil-console/console.db /var/lib/veil-console/secrets.json
ss -ltnp | grep '127.0.0.1:8177'
```

From another computer, confirm that direct port access fails. Then create the supported tunnel:

```sh
ssh -N -L 8177:127.0.0.1:8177 ubuntu@example-server
```

Open `http://127.0.0.1:8177`. Confirm login and process control. Finally, run `sudo systemctl stop veil-console` and confirm that both `veil-console` and its Veil child stop.
