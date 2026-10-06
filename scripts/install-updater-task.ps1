<#
.SYNOPSIS
  Registers (or removes) a Windows Scheduled Task that runs the scheduled updater,
  `cc update --auto`, every five minutes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-updater-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-updater-task.ps1 -Uninstall

.NOTES
  The design is docs/update-proposal.md, section 3. The updater runs outside the daemon, as you,
  with no elevated rights, and installs only signed releases that are newer than what runs. Each
  run is cheap when there is nothing to do. Output is appended to command-center\data\updater.log.
  It reads the same user environment variables as the daemon task (CC_DB, CC_BACKUP_DIR, CC_TZ).

  The task runs whether or not you are logged on (-LogonType S4U): an update that waits for a
  logon would miss the quiet window, and S4U stores no password. One consequence: an S4U task
  has no network credentials, so a backup folder on a network share must be reachable without
  them, or the pre-update snapshot fails and the run stops before anything changes.
#>
param(
  [switch]$Uninstall,
  [string]$TaskName = 'Constellation Updater'
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
$log = Join-Path $dataDir 'updater.log'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $cli)) { throw "Cannot find $cli" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# The one thing the task runs. `--auto` is the scheduled mode: signed releases only, the quiet
# window, the owner's requests from the dashboard, and the status file. Nothing else is scheduled.
$command = "& '$node' '$cli' update --auto *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" `
  -WorkingDirectory (Join-Path $repoRoot 'command-center')

# Every five minutes, for good. The ScheduledTasks module that ships with Windows 10 and later is
# the same one under Windows PowerShell 5.1 and PowerShell 7, and there a repetition with no
# duration repeats indefinitely; [TimeSpan]::MaxValue as the duration is refused on some builds,
# so it is not passed.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)

# IgnoreNew: a run that is still installing is never joined by a second one. One hour is the
# time limit on a run, well above an install (npm ci, the tests, the build, the restart).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# S4U: run as this user whether logged on or not, without storing a password (see NOTES).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName': runs 'cc update --auto' every five minutes as $env:USERNAME, logged on or not."
Write-Host "Log: $log"
Write-Host "Remove it with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File $PSCommandPath -Uninstall"
