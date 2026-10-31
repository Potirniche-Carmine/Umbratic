param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
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
