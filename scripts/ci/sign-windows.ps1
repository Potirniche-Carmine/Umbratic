param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
$name = [IO.Path]::GetFileName($File)
if ($name -match '^(?:vcruntime|msvcp|concrt|vcomp)\d+(?:_[a-z0-9_]+)?\.dll$') {
  # Redistributables keep their original Microsoft signatures. Only exact
  # bytes verified and recorded from this build's toolchain may bypass signing.
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../apps/desktop/.package/windows-runtime/provenance.json') | ConvertFrom-Json
  $entry = @($manifest.files | Where-Object { $_.name -eq $name -and $_.sha256 -eq (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() })
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if ($entry.Count -ne 1 -or $signature.Status -ne 'Valid' -or
      !$signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)CN=(?:Microsoft Corporation|Microsoft Windows Software Compatibility Publisher)(?:,|$)' -or
      $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)' -or
      $signature.SignerCertificate.Thumbprint -ne $entry[0].thumbprint) { throw 'Unverified Microsoft redistributable.' }
  return
}
$pin = Get-Content -Raw (Join-Path $PSScriptRoot '../../third_party/windows-signing.json') | ConvertFrom-Json
$root = $env:UMBRATIC_SIGNING_TOOLS
if (!$root) { throw 'Provision reviewed signing tools with scripts/ci/install-windows-signing.ps1 first.' }
# The native mixed-mode signing library also consults DOTNET_ROOT directly.
$env:DOTNET_ROOT = Join-Path $root 'dotnet'
$env:DOTNET_ROOT_X64 = $env:DOTNET_ROOT
# Builder can sign extra resources concurrently. Each invocation owns its
# metadata file so no process can observe another writer's partial JSON.
$metadata = Join-Path $root ("metadata-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  @{
    Endpoint = $env:UMBRATIC_WIN_SIGN_ENDPOINT
    CodeSigningAccountName = $env:UMBRATIC_WIN_SIGN_ACCOUNT
    CertificateProfileName = $env:UMBRATIC_WIN_SIGN_PROFILE
  } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
  & (Join-Path $root $pin.signTool) sign /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib (Join-Path $root $pin.signingLibrary) /dmdf $metadata $File
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed: $LASTEXITCODE" }
  if ((Get-AuthenticodeSignature -LiteralPath $File).Status -ne 'Valid') { throw "Signed file did not verify: $File" }
} finally {
  Remove-Item -LiteralPath $metadata -Force -ErrorAction SilentlyContinue
}
