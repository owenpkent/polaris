<#
.SYNOPSIS
  Registers (or removes) a Windows Scheduled Task that starts the Command Center daemon at logon.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-command-center-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-command-center-task.ps1 -Uninstall

.NOTES
  Runs as the current user, only while logged on, with no elevated rights.
  Output goes to command-center\data\daemon.log. Environment variables the daemon needs
  (for example CC_TZ and CC_BACKUP_DIR) must be set as user environment variables.
  The daemon runs from this working tree, so it runs whatever branch is checked out.
#>
param(
  [switch]$Uninstall,
  [string]$TaskName = 'Constellation Command Center'
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName'."
  }
  return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot 'command-center\src\cli.ts'
$dataDir = Join-Path $repoRoot 'command-center\data'
$log = Join-Path $dataDir 'daemon.log'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $cli)) { throw "Cannot find $cli" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$command = "& '$node' '$cli' daemon *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" `
  -WorkingDirectory (Join-Path $repoRoot 'command-center')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName'. It starts at next logon. Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Log: $log"
