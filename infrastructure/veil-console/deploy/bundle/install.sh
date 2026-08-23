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
for command in caddy systemctl install useradd curl sha256sum; do
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
if ! id qdrant >/dev/null 2>&1; then
  useradd --system --home /var/lib/qdrant --shell /usr/sbin/nologin qdrant
fi

# A re-run is an upgrade. Note what was already running so the new binaries
# actually take over: `systemctl enable --now` starts a stopped unit and does
# nothing at all to a running one, which used to leave the old process serving
# from replaced binaries until someone rebooted.
console_was_active=no
if systemctl is-active --quiet veil-console 2>/dev/null; then
  console_was_active=yes
fi

install -d -o root -g root -m 0755 /opt/umbratic/veil-console
install -o root -g root -m 0755 "$script_dir/veil" "$script_dir/veil-console" /opt/umbratic/veil-console/
install -o root -g root -m 0755 "$script_dir/umbratic-pdf" /opt/umbratic/veil-console/umbratic-pdf
install -o root -g root -m 0644 "$script_dir/entitlement.json" /opt/umbratic/veil-console/entitlement.json
install -o root -g root -m 0644 "$script_dir/VERSION" /opt/umbratic/veil-console/VERSION

# Qdrant: the vector database behind the Documents tab. It ships in this zip
# rather than being downloaded here, so an install is reproducible and works on
# a box with no route to GitHub.
install -d -o root -g root -m 0755 /opt/umbratic/qdrant
install -o root -g root -m 0755 "$script_dir/qdrant" /opt/umbratic/qdrant/qdrant
install -d -o qdrant -g qdrant -m 0700 /var/lib/qdrant
install -d -o veil-console -g veil-console -m 0700 /var/lib/veil-console
install -d -o root -g root -m 0755 /etc/qdrant

qdrant_key_file=/var/lib/veil-console/qdrant-api-key
if [[ ! -s "$qdrant_key_file" ]]; then
  install -o veil-console -g veil-console -m 0600 /dev/null "$qdrant_key_file"
  head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1 >"$qdrant_key_file"
fi
chown veil-console:veil-console "$qdrant_key_file"
chmod 600 "$qdrant_key_file"
qdrant_api_key="$(cat "$qdrant_key_file")"
sed -e "s|@@QDRANT_API_KEY@@|$qdrant_api_key|g" \
  "$script_dir/qdrant-config.yaml.template" >"$work_dir/qdrant-config.yaml"
install -o qdrant -g qdrant -m 0600 "$work_dir/qdrant-config.yaml" /etc/qdrant/config.yaml
install -o root -g root -m 0644 "$script_dir/qdrant.service.template" /etc/systemd/system/qdrant.service

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
systemctl enable --now qdrant

qdrant_ready=no
for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:6333/readyz >/dev/null 2>&1; then
    qdrant_ready=yes
    break
  fi
  sleep 1
done
if [[ "$qdrant_ready" != yes ]]; then
  echo "Qdrant did not become ready. Check: journalctl -u qdrant" >&2
  exit 1
fi

systemctl enable --now veil-console
if [[ "$console_was_active" == yes ]]; then
  systemctl restart veil-console
fi
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
printf '\nInstall vLLM on this server, then add --vllm-binary /path/to/vllm to the\n'
printf 'veil-console systemd unit so Console can start models from its Models page.\n'
printf 'To answer from company documents, open Documents in Console, set an\n'
printf 'embedding runtime, and upload files. Qdrant runs on 127.0.0.1:6333.\n'
printf '\nSECURITY: This installer does not change your firewall or cloud security group.\n'
printf 'Restrict the Veil HTTPS port to your VPN or approved desktop IP addresses.\n'
printf 'Never publish the private Console, Veil, or vLLM ports.\n'
