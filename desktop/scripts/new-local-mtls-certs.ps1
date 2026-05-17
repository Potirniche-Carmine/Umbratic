param(
  [string]$OutDir = ".aegis\mtls-local",
  [string]$Passphrase = "aegis-local-mtls"
)

$ErrorActionPreference = "Stop"
$resolvedOutDir = Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $OutDir)

function New-AegisSecureString {
  param([string]$Text)
  $secure = New-Object System.Security.SecureString
  foreach ($char in $Text.ToCharArray()) {
    $secure.AppendChar($char)
  }
  $secure.MakeReadOnly()
  return $secure
}

function New-SerialNumber {
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return $bytes
}

function Export-CertificatePem {
  param(
    [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [string]$Path
  )
  $base64 = [Convert]::ToBase64String($Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  $lines = ($base64 -split "(.{1,64})" | Where-Object { $_ })
  $pem = @("-----BEGIN CERTIFICATE-----") + $lines + @("-----END CERTIFICATE-----")
  [System.IO.File]::WriteAllText($Path, ($pem -join [Environment]::NewLine) + [Environment]::NewLine)
}

function New-CertificateRequest {
  param(
    [string]$Subject,
    [System.Security.Cryptography.RSA]$Key
  )
  return [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject),
    $Key,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
}

function Add-EnhancedKeyUsage {
  param(
    [System.Security.Cryptography.X509Certificates.CertificateRequest]$Request,
    [string]$Oid
  )
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([System.Security.Cryptography.Oid]::new($Oid))
  $Request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
  )
}

$password = New-AegisSecureString -Text $Passphrase
$now = [System.DateTimeOffset]::UtcNow.AddMinutes(-5)

$rootKey = [System.Security.Cryptography.RSA]::Create(2048)
$rootRequest = New-CertificateRequest -Subject "CN=Aegis Local Test Root CA" -Key $rootKey
$rootRequest.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$rootRequest.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
    $true
  )
)
$root = $rootRequest.CreateSelfSigned($now, $now.AddDays(30))

$serverKey = [System.Security.Cryptography.RSA]::Create(2048)
$serverRequest = New-CertificateRequest -Subject "CN=localhost" -Key $serverKey
$serverSan = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$serverSan.AddDnsName("localhost")
$serverRequest.CertificateExtensions.Add($serverSan.Build())
Add-EnhancedKeyUsage -Request $serverRequest -Oid "1.3.6.1.5.5.7.3.1"
$serverPublic = $serverRequest.Create($root, $now, $now.AddDays(30), (New-SerialNumber))
$server = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($serverPublic, $serverKey)

$clientKey = [System.Security.Cryptography.RSA]::Create(2048)
$clientRequest = New-CertificateRequest -Subject "CN=aegis-local-client" -Key $clientKey
Add-EnhancedKeyUsage -Request $clientRequest -Oid "1.3.6.1.5.5.7.3.2"
$clientPublic = $clientRequest.Create($root, $now, $now.AddDays(30), (New-SerialNumber))
$client = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($clientPublic, $clientKey)

$caPem = Join-Path $resolvedOutDir "ca.pem"
$serverPfx = Join-Path $resolvedOutDir "server.pfx"
$clientPfx = Join-Path $resolvedOutDir "client.pfx"

Export-CertificatePem -Certificate $root -Path $caPem
[System.IO.File]::WriteAllBytes($serverPfx, $server.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
[System.IO.File]::WriteAllBytes($clientPfx, $client.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))

$rootKey.Dispose()
$serverKey.Dispose()
$clientKey.Dispose()
$root.Dispose()
$server.Dispose()
$client.Dispose()

Write-Host "Created local mTLS files in $resolvedOutDir"
Write-Host "Set these environment variables before starting Aegis:"
Write-Host "  `$env:AEGIS_MODEL_BASE_URL='https://localhost:9443/v1'"
Write-Host "  `$env:AEGIS_MODEL_ID='aegis-mtls-local'"
Write-Host "  `$env:AEGIS_MODEL_MTLS_CA_PATH='$caPem'"
Write-Host "  `$env:AEGIS_MODEL_MTLS_PFX_PATH='$clientPfx'"
Write-Host "  `$env:AEGIS_MODEL_MTLS_PASSPHRASE='$Passphrase'"
