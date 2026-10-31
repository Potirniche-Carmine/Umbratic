#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
version="dev"
architecture="$(go env GOARCH)"
target_os="$(go env GOOS)"
profile=""
dependency_dir=""
output_dir="$repo_root/artifacts/releases"
seats=""
devices_per_user=2
release_dir="$HOME/umbratic-release"
release_env_file="$HOME/.umbratic/release.env"
if [[ "$(uname -s)" == Darwin ]]; then
  release_dir="$repo_root/artifacts/release-work"
  release_env_file="$release_dir/release.env"
fi
signing_key_file="$release_dir/umbratic-entitlement-signing.key"
searches_per_month=0
org_uid=""
positional=0
customer=customer
console_port=8177
veil_port=8080

while [[ $# -gt 0 ]]; do
  case "$1" in
    --console-port) console_port="${2:-}"; shift 2 ;;
    --veil-port) veil_port="${2:-}"; shift 2 ;;
    --customer) customer="${2:-}"; shift 2 ;;
    --os) target_os="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    --dependency-dir) dependency_dir="${2:-}"; shift 2 ;;
    --arch) architecture="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --seats) seats="${2:-}"; shift 2 ;;
    --devices-per-user) devices_per_user="${2:-}"; shift 2 ;;
    --signing-key-file) signing_key_file="${2:-}"; shift 2 ;;
    --searches-per-month) searches_per_month="${2:-}"; shift 2 ;;
    --org-uid) org_uid="${2:-}"; shift 2 ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      if (( positional == 0 )); then
        version="$1"
      elif (( positional == 1 )); then
        output_dir="$1"
      else
        echo "Too many positional arguments." >&2
        exit 2
      fi
      positional=$((positional + 1))
      shift
      ;;
  esac
done

case "$target_os-$architecture" in
  linux-amd64) rust_target=x86_64-unknown-linux-gnu ;;
  linux-arm64) rust_target=aarch64-unknown-linux-gnu ;;
  darwin-arm64) rust_target=aarch64-apple-darwin ;;
  *) echo "Target must be linux-amd64, linux-arm64, or darwin-arm64." >&2; exit 2 ;;
esac
if [[ -z "$profile" ]]; then
  if [[ "$target_os" == darwin ]]; then profile=metal; else profile=cuda; fi
fi
if [[ -z "$dependency_dir" ]]; then dependency_dir="$release_dir/$profile-kit"; fi
if [[ ! -f "$dependency_dir/manifest.json" ]]; then
  echo "Dependency kit missing: $dependency_dir/manifest.json. See docs/guides/release-server.md." >&2
  exit 2
fi

if [[ ! "$customer" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "--customer must be a filename-safe customer label." >&2; exit 2
fi
if [[ ! "$version" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "The version is invalid." >&2
  exit 2
fi
if [[ ! "$seats" =~ ^[0-9]+$ ]] || (( seats < 1 )); then
  echo "--seats must be a positive integer." >&2
  exit 2
fi
if [[ ! "$devices_per_user" =~ ^[0-9]+$ ]] || (( devices_per_user < 1 || devices_per_user > 32 )); then
  echo "--devices-per-user must be between 1 and 32." >&2
  exit 2
fi
if [[ ! "$searches_per_month" =~ ^[0-9]+$ ]] || (( searches_per_month > 100000000 )); then
  echo "--searches-per-month must be between 0 and 100000000." >&2
  exit 2
fi
if [[ -n "$org_uid" && ( ! "$org_uid" =~ ^org_[A-Za-z0-9_-]{8,76}$ ) ]]; then
  echo "--org-uid must be a valid existing organization UID." >&2
  exit 2
fi

# The deployment administrator supplies the optional Brave subscription key
# on the release machine: taken from the
# environment, and otherwise from the one assignment for it in
# the release identity file. The file is read line by line and never sourced — it
# holds credentials, not commands, and sourcing it would run whatever a stray
# line happened to contain.
read_release_env_value() {
  local name="$1" file="$release_env_file" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" == "$name" ]] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # Quotes around a value are allowed and stripped, so the file reads the way
    # it would in a shell â€” the same rule the desktop release's reader applies.
    if (( ${#value} >= 2 )) && [[ ( "$value" == \"*\" ) || ( "$value" == \'*\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "$value"
    return 0
  done <"$file"
}

search_key=""
if (( searches_per_month > 0 )); then
  search_key="${UMBRATIC_BRAVE_SEARCH_API_KEY:-}"
  if [[ -z "$search_key" ]]; then search_key="$(read_release_env_value UMBRATIC_BRAVE_SEARCH_API_KEY)"; fi
  if [[ -z "$search_key" ]]; then echo "Web search requires an administrator-supplied Brave Search credential." >&2; exit 2; fi
fi
# Web search is optional; a zero budget needs no external credential.

mkdir -p "$release_dir/tmp"
chmod 700 "$release_dir" "$release_dir/tmp"
export TMPDIR="$release_dir/tmp"
work_dir="$(mktemp -d "$release_dir/tmp/build.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
bundle_name="umbratic-veil-$version-$customer-$target_os-$architecture"
bundle_dir="$work_dir/$bundle_name"
mkdir -p "$bundle_dir/bin" "$output_dir"

# Generate an administrator-owned signing key if absent and sign this deployment.
entitlement_output="$(
  cd "$repo_root/infrastructure/veil-console"
  entitlement_args=(
    --output "$bundle_dir/entitlement.json"
    --private-key-file "$signing_key_file"
    --seats "$seats"
    --devices-per-user "$devices_per_user"
    --searches-per-month "$searches_per_month"
  )
  if [[ -n "$org_uid" ]]; then
    entitlement_args+=(--org-uid "$org_uid")
  fi
  go run ./cmd/entitlement "${entitlement_args[@]}"
)"
entitlement_public_key="$(printf '%s\n' "$entitlement_output" | sed -n 1p)"

# The optional subscription key read above goes into the
# veil binary and nowhere else â€” not into the bundle directory, not into
# SHA256SUMS, not into Console's environment, and never onto a log line.
veil_ldflags="-X umbratic-veil/internal/entitlement.TrustedPublicKey=$entitlement_public_key"
if [[ -n "$search_key" ]]; then
  veil_ldflags+=" -X umbratic-veil/internal/websearch.SubscriptionKey=$search_key"
fi

(cd "$repo_root/infrastructure/veil" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$architecture" go build -trimpath \
  -ldflags "$veil_ldflags" \
  -o "$bundle_dir/bin/veil" ./cmd/veil)
(cd "$repo_root/infrastructure/veil-console" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$architecture" go build -trimpath \
  -ldflags "-X umbratic-veil-console/internal/entitlement.TrustedPublicKey=$entitlement_public_key" \
  -o "$bundle_dir/bin/veil-console" ./cmd/veil-console)

# The desktop launcher only opens the fixed models directory.
if [[ "$target_os" == darwin ]]; then
  app_dir="$bundle_dir/Models.app/Contents"
  mkdir -p "$app_dir/MacOS"
  cp "$script_dir/models-folder/Info.plist" "$app_dir/Info.plist"
  xcrun swiftc -O -framework Cocoa -target arm64-apple-macosx15.0 \
    "$script_dir/models-folder/main.swift" -o "$app_dir/MacOS/models-folder"
  codesign --force --sign - "$bundle_dir/Models.app"
fi

# The PDF extractor Console spawns for `.pdf` uploads. It is the same crate the
# desktop already ships, built for the server target.
(cd "$repo_root" && cargo build --locked --release --target "$rust_target" -p umbratic-pdf)
install -m 0755 "$repo_root/target/$rust_target/release/umbratic-pdf" "$bundle_dir/bin/umbratic-pdf"

# Dependency resolution and binary review happen on the release machine.
# Customer installs use this exact offline kit; no moving package index is used.
cp -R "$dependency_dir" "$bundle_dir/dependencies"
cp "$dependency_dir/manifest.json" "$bundle_dir/dependencies.json"
rm "$bundle_dir/dependencies/manifest.json"
(cd "$repo_root/infrastructure/veil-console" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$architecture" go build -trimpath \
  -ldflags "-X umbratic-veil-console/internal/entitlement.TrustedPublicKey=$entitlement_public_key" \
  -o "$bundle_dir/bin/deploy" ./cmd/deploy)
install -m 0755 "$script_dir/bundle/deploy.sh" "$bundle_dir/deploy.sh"
install -m 0644 "$repo_root/docs/guides/deploy-customer.md" "$bundle_dir/README.md"
(cd "$repo_root/infrastructure/veil-console" && go run ./cmd/bundle-manifest \
  --directory "$bundle_dir" --version "$version" --os "$target_os" --arch "$architecture" \
  --profile "$profile" \
  --console-port "$console_port" --veil-port "$veil_port")
(cd "$repo_root/infrastructure/veil-console" && go run ./cmd/bundle-zip "$bundle_dir" "$output_dir/$bundle_name.zip")
printf '%s\n' "$output_dir/$bundle_name.zip"
