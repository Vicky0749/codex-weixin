Option Explicit

Dim fso, shell, powershellPath, launcherPath, command, openManagement

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

launcherPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "codex-weixin-launcher.ps1")
If Not fso.FileExists(launcherPath) Then
    WScript.Quit 2
End If

openManagement = False
If WScript.Arguments.Count > 0 Then
    openManagement = LCase(WScript.Arguments.Item(0)) = "open"
End If

powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = Chr(34) & powershellPath & Chr(34) _
    & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
    & Chr(34) & launcherPath & Chr(34) & " -Supervisor"

If Not openManagement Then
    command = command & " -NoOpen"
End If

shell.Run command, 0, False
