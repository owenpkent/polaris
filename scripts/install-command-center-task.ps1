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
  [string]$TaskName = 'Polaris Command Center'
)

$ErrorActionPreference = 'Stop'

# For installs from before the Constellation to Polaris rename: with the default name, the task
# registered under the old name is replaced too, so two copies never run.
$legacyNames = @()
if ($TaskName -eq 'Polaris Command Center') { $legacyNames = @('Constellation Command Center') }

function Remove-NamedTask([string]$Name) {
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "Removed scheduled task '$Name'."
    return $true
  }
  return $false
}

# Unregistering a task does not stop its running process. Stop a running or queued daemon before
# its registration is removed or replaced, otherwise it keeps port 8788 with nothing left to
# control it (and the updater selects Polaris while Constellation still owns the port). On
# failure, keep the registration so the daemon can still be controlled. Returns $true when a stop
# was requested.
function Stop-TaskDaemon([string]$Name) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task -or $task.State -notin @('Running', 'Queued')) { return $false }

  Stop-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    # This installer invokes `daemon` without --port, which always listens on 8788.
    # Query without filters so an empty match is not an error, but a query failure still is.
    $listening = Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq 8788 -and $_.State -eq 'Listen' }
    if ($task.State -notin @('Running', 'Queued') -and -not $listening) { return $true }
    if ((Get-Date) -ge $deadline) {
      throw "The task '$Name' was stopped, but it or port 8788 did not clear within 60 seconds (another daemon may hold the port). Its registration was kept. Start it again with: Start-ScheduledTask -TaskName '$Name'"
    }
    Start-Sleep -Milliseconds 250
  }
}

if ($Uninstall) {
  $removed = $false
  foreach ($name in @($TaskName) + $legacyNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      try { Stop-TaskDaemon $name | Out-Null }
      catch { throw "Could not stop scheduled task '$name', so it was not removed: $($_.Exception.Message)" }
    }
    if (Remove-NamedTask $name) { $removed = $true }
  }
  if (-not $removed) { Write-Host "No scheduled task named '$TaskName'." }
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

$stoppedLegacy = @()
foreach ($name in $legacyNames) {
  if (Stop-TaskDaemon $name) { $stoppedLegacy += $name }
}
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch {
  $message = $_.Exception.Message
  if ($stoppedLegacy.Count -gt 0) {
    $hints = ($stoppedLegacy | ForEach-Object { "Start-ScheduledTask -TaskName '$_'" }) -join '; '
    $message += " The legacy task was stopped and its registration kept. Start it again with: $hints"
  }
  throw $message
}
foreach ($name in $legacyNames) { Remove-NamedTask $name | Out-Null }
Write-Host "Registered '$TaskName'. It starts at next logon. Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Log: $log"
