param([Parameter(Mandatory)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.Pkcs
$files = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
$result = @(foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  $version = (Get-Item -LiteralPath $file).VersionInfo
  $sha256Signature = $false
  if ($signature.Status -eq 'Valid') {
    $bytes = [IO.File]::ReadAllBytes($file)
    $pe = [BitConverter]::ToInt32($bytes, 60)
    $optional = $pe + 24
    $directory = $optional + $(if ([BitConverter]::ToUInt16($bytes, $optional) -eq 0x20b) { 112 } else { 96 })
    $offset = [BitConverter]::ToInt32($bytes, $directory + 32)
    if ($offset -gt 0) {
      $length = [BitConverter]::ToInt32($bytes, $offset)
      if ($length -lt 8 -or $offset -gt $bytes.Length - $length) { throw 'Invalid Authenticode certificate bounds.' }
      $cms = [System.Security.Cryptography.Pkcs.SignedCms]::new()
      $cms.Decode([byte[]]$bytes[($offset + 8)..($offset + $length - 1)])
      $sha256Signature = $cms.SignerInfos.Count -eq 1 -and $cms.SignerInfos[0].DigestAlgorithm.Value -eq '2.16.840.1.101.3.4.2.1'
    }
  }
  @{
    status = $signature.Status.ToString()
    publisher = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }
    subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    timestamp = [bool]$signature.TimeStamperCertificate
    sha256Signature = [bool]$sha256Signature
    productName = $version.ProductName
    productVersion = $version.ProductVersion
  }
})
ConvertTo-Json -InputObject $result -Compress
