param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $File
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)CN=(?:Microsoft Corporation|Microsoft Windows Software Compatibility Publisher)(?:,|$)' -or
    $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
  throw 'Redistributable must have a valid Microsoft Corporation Authenticode signature.'
}
$version = (Get-Item -LiteralPath $File).VersionInfo
@{
  version = $version.FileVersion
  copyright = $version.LegalCopyright
  publisher = $signature.SignerCertificate.Subject
  thumbprint = $signature.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress
