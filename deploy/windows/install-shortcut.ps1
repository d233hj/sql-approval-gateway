param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Name = 'SQL网关'
)

$ErrorActionPreference = 'Stop'

# Two entries:
#   SQL网关            -> Electron runtime + VBS launcher (instant start, daily use)
#   SQL审批网关-便携版  -> single-file portable exe (copyable, first run is slower)
$vbs = Join-Path $RepoPath 'deploy\windows\start-desktop.vbs'
$portableExe = Join-Path $RepoPath 'SQL审批网关.exe'
$appIcon = Join-Path $RepoPath 'packages\desktop\assets\app.ico'

$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell

if (Test-Path $vbs) {
  $lnk = $ws.CreateShortcut((Join-Path $desktop "$Name.lnk"))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $RepoPath
  $lnk.IconLocation = $(if (Test-Path $appIcon) { "$appIcon,0" } else { "$env:WINDIR\System32\shell32.dll,13" })
  $lnk.Description = 'SQL 审批网关（桌面端，秒开）'
  $lnk.Save()
  Write-Host "Desktop shortcut created: $(Join-Path $desktop "$Name.lnk")"
}

if (Test-Path $portableExe) {
  $portableLnk = $ws.CreateShortcut((Join-Path $desktop 'SQL审批网关-便携版.lnk'))
  $portableLnk.TargetPath = $portableExe
  $portableLnk.Arguments = ''
  $portableLnk.WorkingDirectory = $RepoPath
  $portableLnk.IconLocation = "$portableExe,0"
  $portableLnk.Description = 'SQL 审批网关（单文件便携版，可拷贝）'
  $portableLnk.Save()
  Write-Host "Portable shortcut created: $(Join-Path $desktop 'SQL审批网关-便携版.lnk')"
}
