<#
.SYNOPSIS
  Installs (or updates) a Windows Scheduled Task that runs windows-watchdog.ps1 every 2 minutes.
#>
$ScriptPath = Join-Path $PSScriptRoot "windows-watchdog.ps1"
$TaskName = "TheForgeWatchdog"

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Output "Registered Scheduled Task '$TaskName' (every 2 minutes) -> $ScriptPath"
