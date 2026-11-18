' SQL Approval Gateway - manual start: launch core hidden, then open the console.
Option Explicit

Dim fso, sh, here, repo, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetParentFolderName(fso.GetParentFolderName(here))
cmd = repo & "\runtime\run-core.cmd"

If fso.FileExists(cmd) Then
  sh.Run """" & cmd & """", 0, False
End If

WScript.Sleep 2500
sh.Run "http://127.0.0.1:43119", 1, False
