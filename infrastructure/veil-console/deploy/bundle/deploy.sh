#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
# Authenticate the ZIP through the release channel before running its contents.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) shasum -a 256 -c SHA256SUMS >/dev/null ;;
  Linux-x86_64|Linux-aarch64) sha256sum -c SHA256SUMS >/dev/null ;;
  *) echo 'Unsupported host. Use the ZIP for this operating system and CPU.' >&2; exit 1 ;;
esac
exec ./bin/deploy "$@"
