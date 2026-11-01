param([Parameter(Mandatory)][ValidateSet('create','cleanup')][string]$Operation, [Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Fixture certificates are restricted to disposable GitHub-hosted Windows runners.'
}
$identityPath = Join-Path $Directory 'identity.json'
$identity = Get-Content -Raw -LiteralPath $identityPath | ConvertFrom-Json
if ($identity.publisher -notmatch '^Umbratic CI signing fixture [0-9a-f]{32}$') { throw 'Invalid fixture identity.' }
$subject = 'CN=' + $identity.publisher
if ($Operation -eq 'create') {
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddHours(3)
  $publicFile = Join-Path $Directory 'fixture.cer'
  Export-Certificate -Cert $certificate -FilePath $publicFile | Out-Null
  Import-Certificate -FilePath $publicFile -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Import-Certificate -FilePath $publicFile -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
  $identity | Add-Member -MemberType NoteProperty -Name thumbprint -Value $certificate.Thumbprint
  $identity | ConvertTo-Json | Set-Content -LiteralPath $identityPath -Encoding utf8
} else {
  foreach ($store in @('My', 'Root', 'TrustedPublisher')) {
    foreach ($certificate in @(Get-ChildItem -LiteralPath "Cert:\CurrentUser\$store" | Where-Object { $_.Subject -ceq $subject })) {
      if ($store -eq 'My') { Remove-Item -LiteralPath $certificate.PSPath -DeleteKey -Force }
      else { Remove-Item -LiteralPath $certificate.PSPath -Force }
    }
    if (@(Get-ChildItem -LiteralPath "Cert:\CurrentUser\$store" | Where-Object { $_.Subject -ceq $subject }).Count) { throw 'Fixture certificate cleanup failed.' }
  }
}
