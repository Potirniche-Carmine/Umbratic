$ErrorActionPreference = 'Stop'
$pin = Get-Content -Raw (Join-Path $PSScriptRoot '../../third_party/windows-signing.json') | ConvertFrom-Json
$root = if ($env:UMBRATIC_SIGNING_TOOLS) { $env:UMBRATIC_SIGNING_TOOLS } else { Join-Path $env:RUNNER_TEMP 'umbratic-windows-signing' }
New-Item -Path $root -ItemType Directory -Force | Out-Null
foreach ($package in $pin.packages) {
  $algorithm = if ($package.sha512) { 'SHA512' } else { 'SHA256' }
  $expected = if ($package.sha512) { $package.sha512 } else { $package.sha256 }
  $url = [uri]$package.url
  if ($package.name -notmatch '^(sdk|client|dotnet)$' -or $expected -notmatch '^[0-9a-f]+$' -or
      $url.Scheme -cne 'https' -or $url.Host -notin @('api.nuget.org', 'builds.dotnet.microsoft.com')) { throw 'Invalid signing-tool pin.' }
  $archive = Join-Path $root "$($package.name).zip"
  Invoke-WebRequest -Uri $package.url -OutFile $archive
  if ((Get-FileHash -Algorithm $algorithm -LiteralPath $archive).Hash -ine $expected) { throw 'Signing-tool checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $root $package.name) -Force
  Remove-Item -LiteralPath $archive
}
$signTool = Join-Path $root $pin.signTool
$library = Join-Path $root $pin.signingLibrary
foreach ($file in @($signTool, $library)) {
  if (!(Test-Path -LiteralPath $file)) { throw "Signing tool is missing: $file" }
  if ((Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid') { throw "Microsoft signing-tool signature is invalid: $file" }
}
# Isolated x64 runtime makes signing ARM64 payloads independent of host .NET.
$dotnetRoot = Join-Path $root 'dotnet'
& (Join-Path $dotnetRoot 'dotnet.exe') --info
if ($LASTEXITCODE -ne 0) { throw 'Pinned x64 .NET signing runtime did not launch.' }
if ($env:GITHUB_ENV) {
  "DOTNET_ROOT_X64=$dotnetRoot" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  "UMBRATIC_SIGNING_TOOLS=$root" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
