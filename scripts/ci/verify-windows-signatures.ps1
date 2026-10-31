param([Parameter(Mandatory)][string]$Manifest, [Parameter(Mandatory)][string]$Publisher)
$ErrorActionPreference = 'Stop'
$files = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $file ($($signature.Status))" }
  if ((Split-Path -Leaf $file) -match '^Umbratic.*\.exe$') {
    $commonName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($commonName -cne $Publisher) { throw "Unexpected installer/app publisher: $file" }
  }
}
