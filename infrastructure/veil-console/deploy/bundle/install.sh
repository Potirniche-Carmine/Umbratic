#!/usr/bin/env bash
set -euo pipefail

dns_name=""
https_port=8432
console_port=8177
veil_port=8080

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dnsname) dns_name="${2:-}"; shift 2 ;;
    --port) https_port="${2:-}"; shift 2 ;;
    --console-port) console_port="${2:-}"; shift 2 ;;
    --veil-port) veil_port="${2:-}"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$dns_name" ]]; then
  echo "Usage: sudo ./install.sh --dnsname veil.example.com [--port 8432] [--console-port 8177] [--veil-port 8080]" >&2
  exit 2
fi
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
for command in caddy systemctl install useradd; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

if ! id veil-console >/dev/null 2>&1; then
  useradd --system --home /var/lib/veil-console --shell /usr/sbin/nologin veil-console
fi

install -d -o root -g root -m 0755 /opt/umbratic/veil-console
install -o root -g root -m 0755 "$script_dir/veil" "$script_dir/veil-console" /opt/umbratic/veil-console/
install -o root -g root -m 0644 "$script_dir/entitlement.json" /opt/umbratic/veil-console/entitlement.json

bash "$script_dir/render-production-config.sh" \
  "$dns_name" "$work_dir" "$https_port" "$console_port" "$veil_port"
install -o root -g root -m 0644 "$work_dir/veil-console.service" /etc/systemd/system/veil-console.service
install -d -o root -g root -m 0755 /etc/caddy/conf.d
install -o root -g root -m 0644 "$work_dir/veil-console.caddy" /etc/caddy/conf.d/veil-console.caddy

if [[ ! -e /etc/caddy/Caddyfile ]]; then
  install -o root -g root -m 0644 /dev/null /etc/caddy/Caddyfile
fi
if ! grep -Fqx 'import /etc/caddy/conf.d/*.caddy' /etc/caddy/Caddyfile; then
  cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
  printf '\nimport /etc/caddy/conf.d/*.caddy\n' >>/etc/caddy/Caddyfile
fi

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now veil-console
systemctl reload caddy

if [[ "$https_port" == 443 ]]; then
  origin="https://$dns_name"
else
  origin="https://$dns_name:$https_port"
fi
printf '\nVeil and Veil Console are installed.\n'
printf 'Desktop Veil URL: %s\n' "$origin"
printf 'Console stays on 127.0.0.1:%s. Use an SSH tunnel for administrator access.\n' "$console_port"
printf '  ssh -N -L %s:127.0.0.1:%s USER@SERVER\n' "$console_port" "$console_port"
printf 'Then open: http://127.0.0.1:%s/setup\n' "$console_port"
printf 'Read the one-time setup code with:\n  sudo cat /run/veil-console/setup-code\n'
printf '\nOllama or vLLM must run locally before you configure Veil.\n'
printf '\nSECURITY: This installer does not change your firewall or cloud security group.\n'
printf 'Restrict the Veil HTTPS port to your VPN or approved desktop IP addresses.\n'
printf 'Never publish the private Console, Veil, Ollama, or vLLM ports.\n'
