#!/usr/bin/env bash
set -euo pipefail

version="${1:-dev}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
output_dir="${2:-$repo_root/artifacts/releases}"

if [[ ! "$version" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "The version is invalid." >&2
  exit 2
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
bundle_name="umbratic-veil-console-$version-linux-amd64"
bundle_dir="$work_dir/$bundle_name"
mkdir -p "$bundle_dir" "$output_dir"

(cd "$repo_root/infrastructure/veil" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$bundle_dir/veil" ./cmd/veil)
(cd "$repo_root/infrastructure/veil-console" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$bundle_dir/veil-console" ./cmd/veil-console)

install -m 0755 "$script_dir/bundle/install.sh" "$bundle_dir/install.sh"
install -m 0755 "$script_dir/render-production-config.sh" "$bundle_dir/render-production-config.sh"
install -m 0644 "$script_dir/veil-console.production.service.template" "$bundle_dir/veil-console.production.service.template"
install -m 0644 "$script_dir/Caddyfile.template" "$bundle_dir/Caddyfile.template"
install -m 0644 "$repo_root/infrastructure/veil-console/README.md" "$bundle_dir/README.md"

(cd "$bundle_dir" && sha256sum veil veil-console install.sh >SHA256SUMS)
(cd "$repo_root/infrastructure/veil-console" && go run ./cmd/bundle-zip "$bundle_dir" "$output_dir/$bundle_name.zip")
printf '%s\n' "$output_dir/$bundle_name.zip"
