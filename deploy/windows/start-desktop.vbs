' SQL Approval Gateway - start the Electron desktop shell without a console.
'
' The shell is pointed at <repo>\data (the same vault/control database the
' background service core uses) and at the deployment agent token, if present.
' Electron itself lives in <repo>\electron (copied from the npm electron dist).
Option Explicit

Dim fso, shell, wshEnv, scriptDir, repoRoot, tokenFile, token
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(scriptDir))

Set wshEnv = shell.Environment("Process")
wshEnv("SAG_DATA_DIR") = repoRoot & "\data"
' A parent Electron host (e.g. DSH) may export ELECTRON_RUN_AS_NODE=1; with it
' set, electron.exe behaves as plain Node and cannot load its own API. An empty
' value is still "set", so remove the variable instead of clearing it.
On Error Resume Next
wshEnv.Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

tokenFile = repoRoot & "\runtime\agent-token.txt"
If fso.FileExists(tokenFile) Then
  token = Trim(fso.OpenTextFile(tokenFile, 1).ReadAll)
  If Len(token) > 0 Then wshEnv("SAG_AGENT_TOKEN") = token
End If

shell.CurrentDirectory = repoRoot
shell.Run """" & repoRoot & "\electron\electron.exe"" """ & repoRoot & "\packages\desktop""", 1, False
