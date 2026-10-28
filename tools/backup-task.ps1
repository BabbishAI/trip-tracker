# Run the trip-plan backup unattended, for Windows Task Scheduler.
#
# WHY: tools/backup-plan.sh only ever ran when someone remembered to run it, which
# was twice, on the day it was written. When the backend died around 2026-10-08 the
# newest copy was already a week old. A backup nobody runs is not a backup.
#
# The plan id is the password for the whole trip, and this file is in a PUBLIC repo,
# so the id is NOT here. It is read from a file next to the backups, outside the repo:
#     %USERPROFILE%\TripTrackerBackups\plan-id.txt
#
# Install (run once, in PowerShell — it only schedules this script, nothing else):
#   $t = New-ScheduledTaskTrigger -Daily -At 7am
#   $a = New-ScheduledTaskAction -Execute "powershell.exe" `
#        -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\slrog\projects\trip-tracker\tools\backup-task.ps1"'
#   Register-ScheduledTask -TaskName "Trip tracker backup" -Trigger $t -Action $a `
#        -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
#
# -StartWhenAvailable matters: the machine is not on at 7am every day, and without it
# a missed run is simply skipped rather than caught up later.

$ErrorActionPreference = "Stop"

$repo    = Split-Path -Parent $PSScriptRoot
$backups = Join-Path $env:USERPROFILE "TripTrackerBackups"
$idFile  = Join-Path $backups "plan-id.txt"
$logFile = Join-Path $backups "backup-log.txt"

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $msg
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

if (-not (Test-Path $idFile)) {
  Log "NO PLAN ID: expected the plan id in $idFile - nothing backed up."
  exit 1
}

$planId = (Get-Content $idFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($planId)) {
  Log "EMPTY PLAN ID in $idFile - nothing backed up."
  exit 1
}

# Git for Windows ships the bash that backup-plan.sh needs.
$bash = @(
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files (x86)\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bash) {
  Log "COULD NOT FIND bash.exe (Git for Windows) - nothing backed up."
  exit 1
}

$script = Join-Path $repo "tools\backup-plan.sh"
$out = & $bash -lc "cd '$($repo -replace '\','/')' && bash tools/backup-plan.sh '$planId'" 2>&1
$code = $LASTEXITCODE

foreach ($line in $out) { Log $line }

if ($code -ne 0) {
  # Most likely cause, and the one worth shouting about: the project is unreachable
  # again. Existing backups are untouched either way - backup-plan.sh checks before
  # it replaces anything.
  Log "BACKUP FAILED (exit $code). If this repeats, check the Supabase dashboard."
  exit $code
}

Log "Backup OK."
