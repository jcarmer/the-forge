<#
.SYNOPSIS
  Installs (or updates) a Windows Scheduled Task that runs windows-watchdog.ps1 every 2 minutes.
#>
$ScriptPath = Join-Path $PSScriptRoot "windows-watchdog.ps1"
$TaskName = "TheForgeWatchdog"

# `powershell.exe -WindowStyle Hidden` still flashes a console for a moment because the window is created
# before the flag is applied. conhost.exe --headless (Windows 10 1809+/11) never creates a window at all, and
# child processes (docker, wsl) inherit that hidden console. Fall back to the old form if conhost is missing.
$Conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$PsArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""
if (Test-Path $Conhost) {
  $Action = New-ScheduledTaskAction -Execute $Conhost -Argument "--headless powershell.exe $PsArgs"
} else {
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden $PsArgs"
}
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Output "Registered Scheduled Task '$TaskName' (every 2 minutes) -> $ScriptPath"
