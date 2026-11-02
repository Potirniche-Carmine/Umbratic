# Veil Map

- `cmd/veil/`: service entry point.
- `internal/`: configuration, HTTP API, model transport, prompts, policy, identity, and retrieval.

## Verification

From this directory:

```sh
gofmt -w <changed-go-files>
go vet ./...
go test -race ./...
```
