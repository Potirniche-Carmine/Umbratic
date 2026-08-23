#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 5 ]]; then
  echo "Usage: render-production-config.sh <domain> <output-directory> [HTTPS-port] [Console-port] [Veil-port]" >&2
  exit 2
fi

domain="$1"
output_dir="$2"
https_port="${3:-8432}"
console_port="${4:-8177}"
veil_port="${5:-8080}"
case "$domain" in
  ""|.*|-*|*..*|*[^A-Za-z0-9.-]*|*.)
    echo "The Veil domain is invalid." >&2
    exit 2
    ;;
esac
for port in "$https_port" "$console_port" "$veil_port"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    echo "Each port must be between 1 and 65535." >&2
    exit 2
  fi
done
if [[ "$https_port" == 443 ]]; then
  origin="https://$domain"
else
  origin="https://$domain:$https_port"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$output_dir"
sed \
  -e "s|@@ORIGIN@@|$origin|g" \
  -e "s/@@CONSOLE_PORT@@/$console_port/g" \
  -e "s/@@VEIL_PORT@@/$veil_port/g" \
  "$script_dir/veil-console.production.service.template" \
  >"$output_dir/veil-console.service"
sed \
  -e "s|@@ORIGIN@@|$origin|g" \
  -e "s/@@VEIL_PORT@@/$veil_port/g" \
  -e "s/@@CONSOLE_PORT@@/$console_port/g" \
  -e "s/@@HTTPS_PORT@@/$https_port/g" \
  "$script_dir/Caddyfile.template" \
  >"$output_dir/veil-console.caddy"
chmod 600 "$output_dir/veil-console.service" "$output_dir/veil-console.caddy"

printf 'Created:\n%s\n%s\n' \
  "$output_dir/veil-console.service" \
  "$output_dir/veil-console.caddy"
