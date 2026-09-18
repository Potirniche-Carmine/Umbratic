# Veil Console

Local administration for Veil: models, employees, documents, and service controls.

- **Customer:** [Server quickstart](../../docs/guides/deploy-customer.md)
- **Release team:** [Build a customer ZIP](../../docs/guides/release-server.md)
- **Administrator:** [Restart, redeploy, backup, recovery](../../docs/guides/operate-server.md)

For development, run `npm run veil-console:dev` from the repository root. Console opens on `http://127.0.0.1:8177`. The terminal prints the first owner setup code. Managed deployments issue that code privately after readiness checks. A model is not required to initialize Veil or administer employee access.

Console binds to loopback and launches a fixed Veil executable with an allowlisted environment. Model commands become bounded argv, never a shell. Native runtimes and containers use local model files with downloads disabled. The owner session and CSRF protect routine actions; repeated password confirmation is not required. Sessions expire after 10 minutes idle or one hour total.

Go dependencies: `golang.org/x/crypto` provides Argon2id password hashing; `modernc.org/sqlite` stores local state; `golang.org/x/sys` provides the Windows lock. Versions and hashes are recorded in `go.mod` and `go.sum`.

Verify changes with `go test -race ./...` and `go vet ./...`, plus `npm run test:all` from the repository root. Packaged installation and real model serving are separate acceptance checks.

Employee HTTPS is configured under **Connection** on the main Veil page. Fresh installs use `localhost:8432` with private certificates. Console supervises the bundled Caddy child, persists connection settings in SQLite, and uses the active address and public CA certificate in enrollment codes. Changing settings verifies HTTPS before saving and restores the previous connection on failure.
