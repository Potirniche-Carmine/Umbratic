#!/usr/bin/env bash
set -euo pipefail

console_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$console_dir/../.." && pwd)"
smoke_dir="$(mktemp -d)"
state_dir="${1:-$smoke_dir/state}"
runtime_pid=""
console_pid=""

cleanup() {
  if [[ -n "$console_pid" ]]; then
    kill "$console_pid" 2>/dev/null || true
    wait "$console_pid" 2>/dev/null || true
  fi
  if [[ -n "$runtime_pid" ]]; then
    kill "$runtime_pid" 2>/dev/null || true
    wait "$runtime_pid" 2>/dev/null || true
  fi
  rm -rf -- "$smoke_dir"
}
trap cleanup EXIT INT TERM

start_console() {
  if curl --fail --silent --output /dev/null http://127.0.0.1:8177/healthz; then
    echo "Port 8177 is already in use. Stop the active Veil Console before the smoke test." >&2
    exit 1
  fi
  "$smoke_dir/veil-console" \
    --state-dir "$state_dir" \
    --veil-binary "$smoke_dir/veil" \
    >>"$smoke_dir/console.log" 2>&1 &
  console_pid=$!

  for _ in $(seq 1 200); do
    if ! kill -0 "$console_pid" 2>/dev/null; then
      cat "$smoke_dir/console.log" >&2
      echo "Veil Console stopped during startup" >&2
      exit 1
    fi
    if curl --fail --silent --output /dev/null http://127.0.0.1:8177/healthz; then
      return
    fi
    sleep 0.1
  done
  cat "$smoke_dir/console.log" >&2
  echo "Veil Console health check timed out" >&2
  exit 1
}

stop_console() {
  kill "$console_pid"
  wait "$console_pid"
  console_pid=""
}

echo "Smoke directory: $smoke_dir"
echo "State directory: $state_dir"
(cd "$repo_dir/infrastructure/veil" && go build -o "$smoke_dir/veil" ./cmd/veil)
(cd "$console_dir" && go build -o "$smoke_dir/veil-console" ./cmd/veil-console)
(cd "$console_dir" && go build -o "$smoke_dir/fake-runtime" ./internal/supervisor/testdata/fake-runtime)
(cd "$console_dir" && go build -o "$smoke_dir/smoke-client" ./internal/supervisor/testdata/smoke-client)

"$smoke_dir/fake-runtime" >"$smoke_dir/runtime.log" 2>&1 &
runtime_pid=$!

for _ in $(seq 1 50); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:18000/v1/models; then
    break
  fi
  sleep 0.1
done
curl --fail --silent --output /dev/null http://127.0.0.1:18000/v1/models

start_console
for _ in $(seq 1 50); do
  setup_code="$(sed -n 's/^Setup code: //p' "$smoke_dir/console.log" | head -n 1 | tr -d '\r\n')"
  if [[ -n "$setup_code" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "${setup_code:-}" ]]; then
  cat "$smoke_dir/console.log" >&2
  echo "Veil Console setup code is missing" >&2
  exit 1
fi

"$smoke_dir/smoke-client" "$setup_code" "$state_dir"
stop_console
start_console
"$smoke_dir/smoke-client" --verify-persist
stop_console

echo "Veil Console WSL smoke test passed"
