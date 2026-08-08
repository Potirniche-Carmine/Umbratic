#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
version="dev"
output_dir="$repo_root/artifacts/releases"
seats=""
devices_per_user=2
signing_key_file="${UMBRATIC_ENTITLEMENT_SIGNING_KEY_FILE:-}"
org_uid=""
positional=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --seats) seats="${2:-}"; shift 2 ;;
    --devices-per-user) devices_per_user="${2:-}"; shift 2 ;;
    --signing-key-file) signing_key_file="${2:-}"; shift 2 ;;
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
if [[ -z "$signing_key_file" || ! -f "$signing_key_file" ]]; then
  echo "--signing-key-file must name the protected Ed25519 signing key file." >&2
  exit 2
fi
if [[ -n "$org_uid" && ( ! "$org_uid" =~ ^org_[A-Za-z0-9_-]{8,76}$ ) ]]; then
  echo "--org-uid must be a valid existing organization UID." >&2
  exit 2
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
bundle_name="umbratic-veil-console-$version-linux-amd64"
bundle_dir="$work_dir/$bundle_name"
mkdir -p "$bundle_dir" "$output_dir"

entitlement_public_key="$(
  cd "$repo_root/infrastructure/veil-console"
  entitlement_args=(
    --output "$bundle_dir/entitlement.json"
    --private-key-file "$signing_key_file"
    --seats "$seats"
    --devices-per-user "$devices_per_user"
  )
  if [[ -n "$org_uid" ]]; then
    entitlement_args+=(--org-uid "$org_uid")
  fi
  go run ./cmd/entitlement "${entitlement_args[@]}"
)"

(cd "$repo_root/infrastructure/veil" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-X umbratic-veil/internal/entitlement.TrustedPublicKey=$entitlement_public_key" \
  -o "$bundle_dir/veil" ./cmd/veil)
(cd "$repo_root/infrastructure/veil-console" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-X umbratic-veil-console/internal/entitlement.TrustedPublicKey=$entitlement_public_key" \
  -o "$bundle_dir/veil-console" ./cmd/veil-console)

# The PDF extractor Console spawns for `.pdf` uploads. It is the same crate the
# desktop already ships, built for the server target.
(cd "$repo_root" && cargo build --locked --release --target x86_64-unknown-linux-gnu -p umbratic-pdf)
install -m 0755 "$repo_root/target/x86_64-unknown-linux-gnu/release/umbratic-pdf" "$bundle_dir/umbratic-pdf"

# Qdrant is fetched here, at build time, and verified against a pinned digest —
# never downloaded by install.sh. That keeps an install reproducible, immune to
# an upstream retag, and possible on a box with no route to GitHub.
qdrant_version="1.19.0"
qdrant_sha256="9ec667456443463eee390e43cd36988af6b730c6db807b4e39f57c303d0264a3"
qdrant_archive="$work_dir/qdrant.tar.gz"
curl --fail --location --silent --show-error --max-time 300 \
  "https://github.com/qdrant/qdrant/releases/download/v${qdrant_version}/qdrant-x86_64-unknown-linux-musl.tar.gz" \
  -o "$qdrant_archive"
if ! echo "$qdrant_sha256  $qdrant_archive" | sha256sum --check --status; then
  echo "The qdrant download does not match the pinned digest for ${qdrant_version}." >&2
  exit 1
fi
tar -xzf "$qdrant_archive" -C "$work_dir" qdrant
install -m 0755 "$work_dir/qdrant" "$bundle_dir/qdrant"
install -m 0644 "$script_dir/qdrant-config.yaml.template" "$bundle_dir/qdrant-config.yaml.template"
install -m 0644 "$script_dir/qdrant.service.template" "$bundle_dir/qdrant.service.template"

printf '%s\n' "$version" >"$bundle_dir/VERSION"
install -m 0755 "$script_dir/bundle/install.sh" "$bundle_dir/install.sh"
install -m 0755 "$script_dir/render-production-config.sh" "$bundle_dir/render-production-config.sh"
install -m 0644 "$script_dir/veil-console.production.service.template" "$bundle_dir/veil-console.production.service.template"
install -m 0644 "$script_dir/Caddyfile.template" "$bundle_dir/Caddyfile.template"
install -m 0644 "$repo_root/infrastructure/veil-console/README.md" "$bundle_dir/README.md"

(cd "$bundle_dir" && sha256sum veil veil-console umbratic-pdf qdrant entitlement.json install.sh \
  qdrant-config.yaml.template qdrant.service.template VERSION >SHA256SUMS)
(cd "$repo_root/infrastructure/veil-console" && go run ./cmd/bundle-zip "$bundle_dir" "$output_dir/$bundle_name.zip")
printf '%s\n' "$output_dir/$bundle_name.zip"
