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
  # CurrentUser\Root prompts for interactive trust approval. This guarded,
  # disposable hosted VM already runs as administrator; its machine root store
  # supports the noninteractive fixture, and cleanup removes this exact leaf.
  Import-Certificate -FilePath $publicFile -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  $identity | Add-Member -MemberType NoteProperty -Name thumbprint -Value $certificate.Thumbprint
  $identity | ConvertTo-Json | Set-Content -LiteralPath $identityPath -Encoding utf8
} else {
  $cleanupErrors = [System.Collections.Generic.List[string]]::new()
  foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\My')) {
    try { $certificates = @(Get-ChildItem -LiteralPath $store | Where-Object { $_.Subject -ceq $subject }) }
    catch { $cleanupErrors.Add("Unable to inspect fixture store $store."); continue }
    foreach ($certificate in $certificates) {
      try {
        if ($store -eq 'Cert:\CurrentUser\My') { Remove-Item -LiteralPath $certificate.PSPath -DeleteKey -Force }
        else { Remove-Item -LiteralPath $certificate.PSPath -Force }
      } catch { $cleanupErrors.Add("Unable to remove fixture certificate from $store.") }
    }
    try {
      if (@(Get-ChildItem -LiteralPath $store | Where-Object { $_.Subject -ceq $subject }).Count) { $cleanupErrors.Add("Fixture certificate remains in $store.") }
    } catch { $cleanupErrors.Add("Unable to verify fixture cleanup in $store.") }
  }
  if ($cleanupErrors.Count) { throw ($cleanupErrors -join ' ') }
}
