# Registers a Windows Scheduled Task that starts the PaperTrader watchdog at
# logon and restarts the task if it ever stops. Runs as the current user; no
# admin rights needed for a per-user task.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -Uninstall
#
# For a machine that must run with nobody logged on, use NSSM instead (see README).

param([switch]$Uninstall, [string]$TaskName = 'PaperTrader')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cmd = Join-Path $root 'deploy\windows\run-papertrader.cmd'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed scheduled task '$TaskName'."
    return
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'PaperTrader multi-strategy PAPER trading engine (no live orders).' -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' -> $cmd"
Write-Output "Start now with:  Start-ScheduledTask -TaskName $TaskName"
