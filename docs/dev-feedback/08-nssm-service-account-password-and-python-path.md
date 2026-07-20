# QA Feedback: setup-service.ps1's NSSM install breaks under a real service-account password, in two independent ways

**Reported by:** live `npm run test:keep` runs, 2026-07-20 (elevated PowerShell, `NEXUS_BRANCH=refactor/nexus-package`)
**Symptom:** `-CleanInstall` completes, but `vault-knowledge-factory` (the agent service) ends up `Stopped` at validation time. Two distinct root causes surfaced back to back, in the order below — fixing the first exposed the second.

Both fixes below live entirely in `nexus-testing` (`tests/helpers/nexus-install.ts`), not `.testing/nexus` — that clone is throwaway (see `07-vision-agent-sandbox-followup-and-scope-note.md`). Nothing here required editing the Nexus repo itself.

---

## Root cause 1 (fixed): `-ServicePassword`'s interactive fallback collides with this harness's own piped stdin

`setup-service.ps1` installs the agent service to run as the invoking Windows account (not `LocalSystem`), so it can reach a per-user Podman/Docker setup. It resolves the account's password in this order (`system/ops/setup-service.ps1:1191-1204` as of this clone):

```powershell
$svcPassword = $ServicePassword
if (-not $svcPassword -and $env:NEXUS_SERVICE_PASSWORD) {
    $svcPassword = ConvertTo-SecureString $env:NEXUS_SERVICE_PASSWORD -AsPlainText -Force
}
if (-not $svcPassword -and [Environment]::UserInteractive) {
    $svcPassword = Read-Host -AsSecureString "Password for $ServiceAccount (service must run as your account to reach your Podman/Docker setup)"
}
if ($svcPassword) {
    ... & $nssmPath set $ServiceName ObjectName $ServiceAccount $plainPassword ...
} else {
    Log "... will run as LocalSystem ..." "WARN"
}
```

`nexus-install.ts`'s `installFresh()` invokes this over `execFileSync(..., { stdio: ['pipe', ...], input: 'yes\n' })` — the same stdin pipe that answers `-CleanInstall`'s own `Read-Host "Type 'yes' to confirm"`. Neither `-ServicePassword` nor `$env:NEXUS_SERVICE_PASSWORD` was ever set, so the script fell into the interactive branch. Confirmed live: the prompt text (`Password for DESKTOPAITOPX\rodrigo (service must run as your account...)`) printed to the console — proving `[Environment]::UserInteractive` is `$true` here even with piped/redirected stdin (this is an OS-level "does this process have an interactive window station" check, unrelated to whether stdin itself is a pipe).

By the time that second `Read-Host` fires, the pipe is already at EOF (its one line was consumed by `-CleanInstall`'s prompt). PowerShell's `Read-Host -AsSecureString` on a closed pipe doesn't throw — it returns an **empty but non-null** `SecureString`. Critically, `if ($svcPassword)` in PowerShell is `$true` for *any* non-null object reference (a `SecureString` isn't a string, number, or collection for boolean-coercion purposes) — so an empty password is still treated as "a password was provided," and the script never reaches its own `else` branch (`will run as LocalSystem`). Instead:

```
[setup-service] INFO: Running 'vault-knowledge-factory' as DESKTOPAITOPX\rodrigo (not LocalSystem)...
[setup-service] INFO: Starting service 'vault-knowledge-factory'...
...
[setup-service] ERROR:   [FAIL] Agent service 'vault-knowledge-factory': Stopped
```

NSSM installs the service with an empty credential, which Windows rejects at start with a logon failure — surfacing only as a generic `Stopped` / `Validation FAILED`, no mention of a password anywhere in the visible output.

**Practical implication:** the script's documented "no password → LocalSystem" fallback is unreachable from any caller that pipes stdin for `-CleanInstall`'s confirmation (which is required for any non-interactive/automated install) — it will always hit this empty-password logon failure instead, never the graceful LocalSystem path.

**Fix applied (`nexus-install.ts`):** `warnIfServicePasswordMissing()` — logs a loud warning naming the account (`NEXUS_SERVICE_USERNAME` if set, else `$env:COMPUTERNAME\$env:USERNAME`) when `NEXUS_SERVICE_PASSWORD` is unset, since we can't actually force the script onto its safe branch from the outside. Also added `NEXUS_SERVICE_USERNAME` (→ `-ServiceAccount`) and confirmed `NEXUS_SERVICE_PASSWORD` (→ `$env:NEXUS_SERVICE_PASSWORD`, inherited automatically since `execFileSync` passes the full `process.env` through) as the supported non-interactive path. Documented both in `.env.example`. 8 new/updated unit tests cover both branches (password set/unset × username set/unset).

**Verified live:** with `NEXUS_SERVICE_PASSWORD` set, the next run showed `Running 'vault-knowledge-factory' as rodrigo (not LocalSystem)...` / `Service started.` — no more logon failure. This exposed root cause 2 below, which the first run never got far enough to hit.

### Possible upstream fix (Nexus repo, not attempted here)
`Read-Host -AsSecureString`'s result could be checked for actual content (e.g. `$svcPassword.Length -gt 0` via a converted plaintext check) rather than relying on PowerShell's truthiness of the SecureString object itself, so an empty response correctly falls through to the LocalSystem branch instead of attempting install with an empty credential. Flagging as an observation — this is the Nexus maintainer's call.

---

## Root cause 2 (fixed): `-Python` defaults to the bare command `"python"`, which NSSM/Windows can't resolve under a service-logon session

Once root cause 1 was fixed, the service installed with a real password and actually attempted to start — and immediately failed differently:

```
Failed to start service vault-knowledge-factory.  Program python couldn't be launched.
CreateProcess() failed: The system cannot find the file specified.
```

(from Windows's Application event log, `Get-WinEvent -FilterHashtable @{LogName='Application'}`, Event ID 1010, source nssm — `service-stdout.log`/`service-stderr.log` were both 0 bytes, so this never surfaces in any file the daemon itself writes.)

`setup-service.ps1`'s `-Python` param defaults to the literal string `"python"` (`system/ops/setup-service.ps1:47`), and hands that literal straight to NSSM: `& $nssmPath install $ServiceName $Python ...` (`:1171`). NSSM stores the literal `"python"` as the service's `Application` value; Windows resolves it via `CreateProcess` at **service** launch time, under whatever session the service account's logon runs in — not the interactive shell that ran `setup-service.ps1`.

Confirmed via direct PATH inspection (`[Environment]::GetEnvironmentVariable('PATH', 'Machine')` vs `'User'`):

| | Machine (system-wide) PATH | User PATH |
|---|---|---|
| `podman.exe` | ✅ `C:\Users\rodrigo\AppData\Local\Programs\Podman` | ✅ (redundant) |
| `python.exe` | ❌ absent | ✅ `C:\opt\Python\Python310\` |

A service-logon session inherits the Machine PATH, not the interactive user's HKCU-scoped PATH additions — so `python` (installed only under a per-user directory here) is invisible to it, while `podman`/`docker` (already machine-wide) are unaffected. This is exactly the same class of bug as root cause 1 in spirit — something that works fine in the interactive shell running the installer silently breaks once control passes to the actual service-logon session — just manifesting through PATH resolution instead of stdin/Read-Host.

**Fix applied (`nexus-install.ts`):** `resolvePythonExecutable()` shells out to `where python` *while still in the working interactive shell* and passes the resolved absolute path via `-Python <path>` — an absolute path needs no PATH lookup at `CreateProcess` time, sidestepping the bug entirely regardless of which account/session the service ends up running under. Best-effort: if `where python` fails, no `-Python` arg is passed and the script's own bare-`"python"` default (and its own clear pre-flight error, `system/ops/setup-service.ps1:1067`) applies unchanged. 2 new unit tests cover both branches.

**Also checked and ruled out as a risk:** `podman`/`docker` (used by the vision-agent's sandboxed dispatch, from *inside* the same service process — see `03-vision-agent-sandbox-runtime-missing.md`) are already in the Machine PATH here, so they should not hit this same failure mode. Not yet confirmed against a live run where the service actually reaches a vision-agent dispatch cycle.

### Possible upstream fix (Nexus repo, not attempted here)
Resolve `$Python` to `(Get-Command $Python).Source` (or equivalent) before handing it to `nssm install`, the same way this harness now does from the outside — so any caller gets a working service regardless of whether Python happens to be on the Machine-wide PATH. Same fix shape applies to any other bare-command NSSM `Application` value the script might set for a per-user-account service.

---

## Status as of this writing

- Both fixes implemented in `tests/helpers/nexus-install.ts`, documented in `.env.example` (`NEXUS_SERVICE_USERNAME`, `NEXUS_SERVICE_PASSWORD`).
- 82/82 unit tests pass (`npm run test:unit`), lint clean (`npm run lint`).
- **Both root causes confirmed fixed live** (`npm run test:keep`, 2026-07-20 07:21 UTC):
  ```
  [setup-service] INFO: Python      : C:\opt\Python\Python310\python.exe
  [setup-service] INFO: Running 'vault-knowledge-factory' as rodrigo (not LocalSystem)...
  [setup-service] INFO: Service started.
  ...
  [setup-service] INFO:   [PASS] Agent service 'vault-knowledge-factory': Running
  [setup-service] INFO:   [PASS] Runner process(es) active - PIDs: 8056
  [setup-service] INFO:   [PASS] Lock PID 8056 alive (python)
  [setup-service] INFO: --- Validation PASSED ---
  ```
  The service reached and stayed in `Running` through full validation — the resolved absolute Python path (`-Python C:\opt\Python\Python310\python.exe`) is what NSSM's service-logon session actually launched, confirming the fix. The subsequent Playwright run also showed the vision/lore pipeline actively producing drafts (`location-annun-harbor.md`, `lore-sunken-bell-annun.md`) for at least one in-flight image, i.e. the daemon is live and dispatching, not just installed.
