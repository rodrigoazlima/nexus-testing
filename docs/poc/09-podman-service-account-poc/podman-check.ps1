# nexus-install-poc: runs as the installed service. Proves whether *this*
# logon session can see the invoking user's Podman machine - the exact
# failure mode behind vision-agent's "Cannot connect to Podman" (podman
# machine connections live under the user profile; LocalSystem has none).
#
# Loops forever instead of exiting after one check: NSSM treats an app that
# repeatedly exits faster than it can confirm a stable start as crash-looping
# and pauses the service (SERVICE_PAUSED) regardless of exit code - seen live
# even with podman info exit=0. A persistent process (same shape as the real
# nexus runner daemon) sidesteps NSSM's restart/throttle machinery entirely.
$logPath = Join-Path $env:TEMP 'nexus-podman-poc.log'

function Write-Poc([string]$msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8
}

Write-Poc "--- SERVICE START ---"
Write-Poc "whoami: $(whoami)"
Write-Poc "USERNAME=$env:USERNAME USERPROFILE=$env:USERPROFILE"

while ($true) {
    Write-Poc "--- CHECK START ---"
    $podman = Get-Command podman -ErrorAction SilentlyContinue
    if (-not $podman) {
        Write-Poc "ERROR: podman not found on PATH for this session"
        Write-Poc "--- CHECK DONE (exit 127) ---"
    } else {
        Write-Poc "podman path: $($podman.Source)"
        $info = & podman info 2>&1
        $exit = $LASTEXITCODE
        Write-Poc "podman info exit=$exit"
        $info | ForEach-Object { Write-Poc "  $_" }
        if ($exit -eq 0) {
            Write-Poc "RESULT: podman reachable from this service session"
        } else {
            Write-Poc "RESULT: podman NOT reachable from this service session"
        }
        Write-Poc "--- CHECK DONE ---"
    }
    Start-Sleep -Seconds 60
}
