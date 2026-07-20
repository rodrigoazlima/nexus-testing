# nexus-install-poc: install-poc.ps1
# Installs a Windows service the same way system\ops\setup-service.ps1 does
# (NSSM, service account from .env, qualified bare username) but running only
# podman-check.ps1 - a minimal repro to isolate the "Cannot connect to
# Podman" failure from the rest of the real Nexus daemon.
param(
    [string]$ServiceName = "nexus-podman-poc",
    [string]$EnvFile     = "C:\opt\GitHub\nexus-testing\.env"
)
$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run elevated (Administrator PowerShell)."
}

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw "nssm not found on PATH (winget install nssm, or add it to PATH)." }

if (-not (Test-Path $EnvFile)) { throw "EnvFile not found: $EnvFile" }
$envVars = @{}
Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#\s][^=]*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $envVars[$k.Trim()] = $v.Trim()
}
$user = $envVars['NEXUS_SERVICE_USERNAME']
$pass = $envVars['NEXUS_SERVICE_PASSWORD']
if (-not $user -or -not $pass) { throw "NEXUS_SERVICE_USERNAME/NEXUS_SERVICE_PASSWORD not set in $EnvFile" }
if ($user -notmatch '\\') { $user = ".\$user" }  # bare account -> qualify; NSSM's ChangeServiceConfig rejects bare names (same bug just fixed in nexus-install.ts)

$scriptPath = Join-Path $PSScriptRoot "podman-check.ps1"
$psExe = (Get-Command powershell.exe).Source

& $nssm install $ServiceName $psExe "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
& $nssm set $ServiceName AppDirectory $PSScriptRoot   # podman-check.ps1 loops forever - no AppExit/AppThrottle needed
& $nssm set $ServiceName ObjectName $user $pass
$setResult = & $nssm start $ServiceName 2>&1

Write-Host "Installed '$ServiceName' -> account requested: $user"
Write-Host "nssm start: $setResult"
Write-Host "Actual StartName (check for silent LocalSystem fallback):"
Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" | Select-Object Name, StartName, State
Write-Host "Log: $env:TEMP\nexus-podman-poc.log"
