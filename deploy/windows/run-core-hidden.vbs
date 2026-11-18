' SQL Approval Gateway - hidden launcher for the login autostart shortcut.
' Runs <repo>\runtime\run-core.cmd with no console window.
Option Explicit

Dim fso, sh, here, repo, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetParentFolderName(fso.GetParentFolderName(here))
cmd = repo & "\runtime\run-core.cmd"

If Not fso.FileExists(cmd) Then
  WScript.Quit 1
End If

sh.Run """" & cmd & """", 0, False
