#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RUNNER_OS:-}" == macOS ]] || {
  echo 'Signing setup requires an ephemeral GitHub-hosted macOS runner.' >&2
  exit 1
}
umask 077
node --input-type=module - <<'JAVASCRIPT'
import fs from 'node:fs';
import assert from 'node:assert/strict';
for (const key of ['MACOS_CERTIFICATE_P12', 'MACOS_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) {
  assert.ok(process.env[key]?.trim(), `Configure release secret ${key}`);
}
assert.match(process.env.APPLE_TEAM_ID ?? '', /^[A-Z0-9]{10}$/, 'Invalid APPLE_TEAM_ID');
const encoded = process.env.MACOS_CERTIFICATE_P12.replace(/\s/g, '');
const certificate = Buffer.from(encoded, 'base64');
assert.ok(certificate.length > 0 && certificate.toString('base64') === encoded, 'Certificate must be base64 PKCS#12');
fs.writeFileSync(`${process.env.RUNNER_TEMP}/umbratic-signing.p12`, certificate, {mode: 0o600, flag: 'wx'});
JAVASCRIPT
keychain="$RUNNER_TEMP/umbratic-release.keychain-db"
keychain_password="$(openssl rand -hex 32)"
echo "::add-mask::$keychain_password"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$RUNNER_TEMP/umbratic-signing.p12" -k "$keychain" -f pkcs12 -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
identity="$(security find-identity -v -p codesigning "$keychain" | sed -n "s/.*\([A-F0-9]\{40\}\).*Developer ID Application:.*($APPLE_TEAM_ID).*/\1/p")"
[[ "$identity" =~ ^[A-F0-9]{40}$ ]] || { echo 'Expected exactly one Developer ID Application identity for APPLE_TEAM_ID.' >&2; exit 1; }
probe="$RUNNER_TEMP/umbratic-signing-probe"
printf 'int main(void) { return 0; }\n' | xcrun clang -x c - -o "$probe"
codesign --force --sign "$identity" --keychain "$keychain" --options runtime --timestamp "$probe"
codesign --verify --strict "$probe"
xcrun notarytool store-credentials Umbratic-CI --keychain "$keychain" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
{
  echo "CSC_KEYCHAIN=$keychain"
  echo "CSC_NAME=$identity"
  echo 'UMBRATIC_NOTARY_PROFILE=Umbratic-CI'
} >> "$GITHUB_ENV"
rm -f "$RUNNER_TEMP/umbratic-signing.p12" "$probe"
