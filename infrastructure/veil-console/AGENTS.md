# Veil Console Map

- `cmd/`: Console, release archive, and entitlement commands.
- `internal/`: authentication, configuration, state, process supervision, web UI, and document ingestion.
- `deploy/`: deployment and packaging resources.

## Verification

From this directory:

```sh
gofmt -w <changed-go-files>
go vet ./...
go test -race ./...
```
