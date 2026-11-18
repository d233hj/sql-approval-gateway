param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'SQLApprovalGateway\data'),
  [int]$Port = 43119
)

$ErrorActionPreference = 'Stop'

$cli = Join-Path $RepoPath 'packages\core\dist\src\cli.js'
$web = Join-Path $RepoPath 'packages\web\dist\index.html'
if (-not (Test-Path $cli)) {
  throw "找不到 $cli；请先运行: npm run build -w @sql-approval/core"
}
if (-not (Test-Path $web)) {
  throw "找不到 $web；请先运行: npm run build -w @sql-approval/web"
}

$root = Join-Path $env:LOCALAPPDATA 'SQLApprovalGateway'
$logs = Join-Path $RepoPath 'logs'
New-Item -ItemType Directory -Force -Path $root, $logs, $DataDir | Out-Null

$logPath = Join-Path $logs 'core.log'
$cmdPath = Join-Path $root 'run-core.cmd'
$vbsPath = Join-Path $PSScriptRoot 'run-core-hidden.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'SQL Approval Gateway.lnk'

$config = [ordered]@{
  repoPath = $RepoPath
  dataDir  = $DataDir
  port     = $Port
  logPath  = $logPath
  cliPath  = $cli
  installedAt = (Get-Date).ToString('o')
}
$config | ConvertTo-Json | Set-Content -Path (Join-Path $root 'autostart.json') -Encoding UTF8

$cmd = @"
@echo off
cd /d "$RepoPath"
node "$cli" --data-dir "$DataDir" --port $Port >> "$logPath" 2>&1
"@
$cmd | Set-Content -Path $cmdPath -Encoding ASCII

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + $vbsPath + '"'
$lnk.WorkingDirectory = $RepoPath
$lnk.WindowStyle = 7
$lnk.Description = 'SQL Approval Gateway core (hidden, login autostart)'
$lnk.Save()

Write-Host 'Autostart installed.'
Write-Host "  shortcut : $lnkPath"
Write-Host "  launcher : $cmdPath"
Write-Host "  data dir : $DataDir"
Write-Host "  log      : $logPath"
Write-Host "  health   : http://127.0.0.1:$Port/v1/health"
Write-Host ''
Write-Host ("Test now: wscript.exe `"" + $vbsPath + "`"")
Write-Host 'Remove  : powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-autostart.ps1'
