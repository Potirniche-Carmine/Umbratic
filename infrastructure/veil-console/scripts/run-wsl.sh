#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
shift || true
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"

case "$action" in
  build)
    mkdir -p "$repo_root/artifacts"
    (cd "$repo_root/infrastructure/veil" && go build -o "$repo_root/artifacts/veil" ./cmd/veil)
    (cd "$repo_root/infrastructure/veil-console" && go build -o "$repo_root/artifacts/veil-console" ./cmd/veil-console)
    ;;
  start)
    state_dir="${1:-${VEIL_CONSOLE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/veil-console}}"
    mkdir -p "$state_dir/bin"
    (cd "$repo_root/infrastructure/veil" && go build -o "$state_dir/bin/veil" ./cmd/veil)
    (cd "$repo_root/infrastructure/veil-console" && go build -o "$state_dir/bin/veil-console" ./cmd/veil-console)
    chmod 700 "$state_dir/bin/veil" "$state_dir/bin/veil-console"
    exec "$state_dir/bin/veil-console" --state-dir "$state_dir" --veil-binary "$state_dir/bin/veil"
    ;;
  smoke)
    exec bash "$repo_root/infrastructure/veil-console/scripts/smoke-wsl.sh"
    ;;
  release)
    exec bash "$repo_root/infrastructure/veil-console/deploy/build-release-zip.sh" "$@"
    ;;
  *)
    echo "Usage: run-wsl.sh <build|start|smoke|release> [options]" >&2
    exit 2
    ;;
esac
