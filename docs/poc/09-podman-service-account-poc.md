# QA Feedback: vision-agent's "Cannot connect to Podman" — service silently falls back to LocalSystem on a bare `NEXUS_SERVICE_USERNAME`

**Reported by:** live `automation.log`, 2026-07-20 (`vault-knowledge-factory` service, `NEXUS_BRANCH=refactor/nexus-package`)
**Symptom:** vision-agent's sandboxed dispatch (`nexus.tasks.sandbox_run`) fails every cycle:

```
[vision-agent] ERROR: Sandboxed dispatch failed: `podman info` failed (exit 125): Cannot connect to Podman.
Please verify your connection to the Linux system using `podman system connection list`, or try
`podman machine init` and `podman machine start` to manage a new Linux VM
```

`podman machine` was running and healthy interactively the whole time. This is a different, earlier failure than `08-nssm-service-account-password-and-python-path.md`'s two root causes — those are fixed and confirmed live, but the service still wasn't reaching them cleanly for Podman specifically.

---

## Root cause: `ChangeServiceConfig` rejects a bare account name; NSSM install falls back to LocalSystem, which has no user profile and no Podman machine connection

`Get-CimInstance Win32_Service -Filter "Name='vault-knowledge-factory'"` showed `StartName: LocalSystem` despite `.env` having both `NEXUS_SERVICE_USERNAME=rodrigo` and `NEXUS_SERVICE_PASSWORD` set. `agents\runtime\state\logs\nssm-install.log` had the actual error, silent everywhere else:

```
Error editing service!
ChangeServiceConfig(): The account name is invalid or does not exist, or the password is invalid for the account name specified.
Error setting parameter "ObjectName" for service "vault-knowledge-factory"!
```

Isolated the two possible causes of that error (bad password vs. bad account-name format):

```powershell
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')
$ctx.ValidateCredentials('rodrigo','<password>')   # -> True
```

Password is correct. The problem is the account-name format: `nexus-install.ts` passes `NEXUS_SERVICE_USERNAME` straight through to `setup-service.ps1 -ServiceAccount`, and `.env` had it as the bare `rodrigo` — no `.\` or `DESKTOPAITOPX\` qualifier. Win32's `ChangeServiceConfig` (which NSSM's `set ObjectName` wraps) rejects that bare form outright, distinct from `LogonUser`/`ValidateCredentials` (used above, and by Windows interactive logon) which accepts it fine — hence the password checked out standalone while the service install still failed with the same generic error text.

Same shape as both `08`'s root causes: something that resolves fine in the interactive/validation path silently breaks once handed to the actual service-install API.

**Fix applied (`tests/helpers/nexus-install.ts`):** added `resolveServiceAccount()` — qualifies a bare username (`rodrigo` → `.\rodrigo`) before it reaches either `ensureServiceLogonRight()` or the `-ServiceAccount` arg. Previously those two call sites independently recomputed the account string from `process.env.NEXUS_SERVICE_USERNAME`, one of them unqualified — a second latent instance of the same bug, fixed by routing both through the one normalizer.

### Possible upstream fix (Nexus repo, not attempted here)
`setup-service.ps1` could qualify `$ServiceAccount` itself (`.\$ServiceAccount` when no `\` present) before calling `nssm set ObjectName`, so any bare-username caller gets a working install regardless of which harness invokes it.

---

## POC: isolated reproduction, `docs/dev-feedback/09-podman-service-account-poc/`

Rather than cycle the full Nexus daemon (clone + pip install + full agent stack) for every retest, built a minimal standalone NSSM service that only runs `podman info` and logs the result — isolates "does *this* service-logon session see Podman" from everything else the real daemon does.

- `podman-check.ps1` — logs `whoami`, `$env:USERNAME`, `podman info`'s exit code and full output to `%TEMP%\nexus-podman-poc.log`. Loops with `Start-Sleep -Seconds 60` rather than exiting once per run.
- `install-poc.ps1` — installs it as service `nexus-podman-poc` via NSSM, reading `NEXUS_SERVICE_USERNAME`/`NEXUS_SERVICE_PASSWORD` from `nexus-testing/.env` and applying the same bare-username qualification as the real fix above.
- `uninstall-poc.ps1` — stop + remove.

### POC bug 1: reproduced the exact fix under test
First install (before qualifying the username) — not run, since the fix was written before this POC existed. First *POC* run already had the fix, and confirmed it end to end:

```
Name             StartName State
----             --------- -----
nexus-podman-poc .\rodrigo Running
```

```
[2026-07-20 08:25:56] whoami: desktopaitopx\rodrigo
[2026-07-20 08:25:56] podman info exit=0
...
[2026-07-20 08:25:56] RESULT: podman reachable from this service session
```

Confirms the theory directly: a service running as the real user account (not LocalSystem) reaches Podman fine. No separate Podman-side fix needed — the account-qualification fix in `nexus-install.ts` is sufficient.

### POC bug 2: NSSM crash-loop guard pauses a service that exits too fast, even on exit 0
First install attempt (using `AppExit Default Restart` + `AppThrottle 60000` to re-run the check every 60s by letting the script exit and NSSM restart it) landed the service in `SERVICE_PAUSED`:

```
nssm start: nexus-podman-poc: Unexpected status SERVICE_PAUSED in response to START control.
```

`podman-check.ps1` exits in under a second every cycle; NSSM's restart-throttle treats consistently-fast exits as crash-looping and pauses the service regardless of exit code — the log showed `podman info exit=0` for the run that triggered the pause. **Fix:** rewrote `podman-check.ps1` as a persistent loop (`while ($true) { ...; Start-Sleep -Seconds 60 }`) instead of relying on NSSM's exit/restart cycle — same shape as the real `nexus.runner` daemon process. Removed the now-unneeded `AppExit`/`AppThrottle` tuning from `install-poc.ps1`, added `AppDirectory` (parity with `setup-service.ps1`, which always sets it). Reinstalled, confirmed `State: Running` (not `Paused`), log continuing to append every 60s.

### POC bug 3: `uninstall-poc.ps1` didn't check `nssm remove`'s exit code
Printed `Removed '<service>'` unconditionally even when `nssm remove` failed for lack of elevation (`Administrator access is needed to remove a service.`) — masked a real failure as success, discovered when a stale service instance kept a directory locked during a file move. Fixed: added an explicit elevation check up front and `if ($LASTEXITCODE -ne 0) { throw ... }` after the `remove` call.

---

## Status as of this writing

- Fix live in `tests/helpers/nexus-install.ts` (`resolveServiceAccount()`), typecheck + lint clean.
- POC confirms the fix resolves Podman connectivity under a real service-logon session, isolated from the rest of the daemon.
- **Not yet done:** reinstalling the real `vault-knowledge-factory` service with the fix and confirming `StartName` is no longer `LocalSystem`, then watching a live vision-agent cycle for the `Cannot connect to Podman` error to actually disappear from `automation.log`. The POC proves the mechanism; the real service hasn't been reinstalled with the fix yet.
