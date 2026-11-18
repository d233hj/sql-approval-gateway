param(
  [int]$Port = 43119
)

$ErrorActionPreference = 'Continue'
$root = Join-Path $env:LOCALAPPDATA 'SQLApprovalGateway'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'SQL Approval Gateway.lnk'
$jsonPath = Join-Path $root 'autostart.json'
$logPath = Join-Path $root 'logs\core.log'
if (Test-Path $jsonPath) {
  try { $logPath = (Get-Content $jsonPath -Raw | ConvertFrom-Json).logPath } catch {}
}

Write-Host "shortcut : $(if (Test-Path $lnkPath) { 'present' } else { 'missing' })  $lnkPath"
Write-Host "config   : $(if (Test-Path $jsonPath) { 'present' } else { 'missing' })  $jsonPath"
Write-Host "log      : $logPath"

try {
  $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/v1/health" -TimeoutSec 3
  Write-Host "health   : $($health.StatusCode) $($health.Content)"
} catch {
  Write-Host "health   : DOWN ($($_.Exception.Message))"
}

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match 'cli\.js' -and
    $_.CommandLine -match '--data-dir' -and
    $_.CommandLine -notmatch 'npm-cli\.js'
  }
if ($procs) {
  $procs | ForEach-Object { Write-Host "process  : pid=$($_.ProcessId)" }
} else {
  Write-Host 'process  : no core process matched'
}

if (Test-Path $logPath) {
  Write-Host '--- log tail ---'
  Get-Content $logPath -Tail 10
}
