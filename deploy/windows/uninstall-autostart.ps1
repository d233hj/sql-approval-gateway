param(
  [switch]$KeepLauncher
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'SQLApprovalGateway'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'SQL Approval Gateway.lnk'
$cmdPath = Join-Path $root 'run-core.cmd'
$jsonPath = Join-Path $root 'autostart.json'

foreach ($p in @($lnkPath, $jsonPath)) {
  if (Test-Path $p) { Remove-Item -Force $p; Write-Host "removed $p" }
}
if (-not $KeepLauncher -and (Test-Path $cmdPath)) {
  Remove-Item -Force $cmdPath; Write-Host "removed $cmdPath"
}
Write-Host 'Autostart removed. Data directory and logs are kept.'
Write-Host "  data: $(Join-Path $root 'data')"
Write-Host "  logs: $(Join-Path $root 'logs')"
