param([string]$ServiceName = "nexus-podman-poc")
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run elevated (Administrator PowerShell)."
}
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw "nssm not found on PATH." }
& $nssm stop $ServiceName 2>$null
& $nssm remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) { throw "nssm remove failed (exit $LASTEXITCODE) - service may still be running." }
Write-Host "Removed '$ServiceName'."
