# Review and pin the official LunarG SDK before executing its installer.
$ErrorActionPreference = 'Stop'
$pin = Get-Content -Raw third_party/vulkan-sdk.json | ConvertFrom-Json
$version = $pin.version
$expected = $pin.sha256
if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $expected -notmatch '^[a-fA-F0-9]{64}$' -or
    $pin.url -cne "https://sdk.lunarg.com/sdk/download/$version/windows/vulkansdk-windows-X64-$version.exe") {
  throw 'Invalid reviewed Vulkan SDK pin.'
}
$installer = Join-Path $env:RUNNER_TEMP 'vulkan-sdk.exe'
Invoke-WebRequest -Uri $pin.url -OutFile $installer
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash -ine $expected) { throw 'Vulkan SDK checksum mismatch.' }
$destination = Join-Path $env:RUNNER_TEMP 'VulkanSDK'
$process = Start-Process -Wait -PassThru -FilePath $installer -ArgumentList @('--root', $destination, '--accept-licenses', '--default-answer', '--confirm-command', 'install')
if ($process.ExitCode -ne 0) { throw "Vulkan SDK install failed: $($process.ExitCode)" }
if (!(Test-Path "$destination/Bin/glslc.exe")) { throw 'Vulkan SDK shader compiler is missing.' }
"VULKAN_SDK=$destination" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"$destination/Bin" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
Remove-Item -LiteralPath $installer
