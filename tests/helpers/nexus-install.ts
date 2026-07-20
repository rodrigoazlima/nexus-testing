import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, VAULT_PATH } from './config';
import { removeDirWithRetry } from './dir-lock-cleanup';

// NTFS required — setup-service.ps1 links agents via junctions, which exFAT
// doesn't support ("Incorrect function" on creation). Default resolves under
// ROOT_DIR (not cwd) so it lands on whatever drive the repo itself is
// checked out on, regardless of invocation directory.
export const NEXUS_PATH = path.resolve(process.env.NEXUS_PATH ?? path.join(ROOT_DIR, '.testing', 'nexus'));
export const REPO_URL = process.env.NEXUS_REPO_URL ?? 'https://github.com/rodrigoazlima/NexusCampaigns.git';
// Lets a run target a feature branch of Nexus (e.g. to test against
// in-progress agent changes) without editing this file. Read once at module
// load, same as NEXUS_PATH/VAULT_PATH above — set NEXUS_BRANCH in .env.
export const BRANCH = process.env.NEXUS_BRANCH ?? 'master';
export const SETUP_SCRIPT = process.env.SETUP_SCRIPT ?? path.join(NEXUS_PATH, 'system', 'ops', 'setup-service.ps1');
export const REGISTRY_PATH = process.env.REGISTRY_PATH ?? path.join(NEXUS_PATH, 'agents', 'registry.yaml');

// Guards clearInstall/installFresh (global-setup, global-teardown, clean.ts)
// against overlapping each other — e.g. `npm run clean` fired while a test
// run's global-setup is mid-clone. Test workers never touch this lock: they
// don't call clearInstall/installFresh, only the three entry points above do.
const LOCK_PATH = path.join(ROOT_DIR, '.testing', '.install.lock');

export function withInstallLock<T>(label: string, fn: () => T): T {
  if (fs.existsSync(LOCK_PATH)) {
    const heldBy = fs.readFileSync(LOCK_PATH, 'utf-8').trim();
    throw new Error(
      `${label}: install/uninstall already in progress (pid ${heldBy || '?'}, lock: ${LOCK_PATH}). ` +
        `Refusing to run concurrently — wait for it to finish, or delete the lock file if it's stale.`
    );
  }
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
}

function run(cmd: string, args: string[], input?: string): void {
  if (input !== undefined) {
    execFileSync(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], input });
  } else {
    execFileSync(cmd, args, { stdio: 'inherit' });
  }
}

// setup-service.ps1 installs a Windows service, which silently fails deep
// inside the script without an elevated shell (2026-07-09 perf review,
// finding #5: the resulting error doesn't point at "run as admin"). Check
// up front and throw a clear error instead.
function assertElevated(): void {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `${SETUP_SCRIPT} installs a Windows service, which requires an elevated shell. ` +
        `Re-run from PowerShell started as Administrator.`
    );
  }
}

// setup-service.ps1 installs the agent service to run as the invoking
// Windows account (not LocalSystem) so it can reach a per-user Podman/Docker
// setup. It takes the account password from -ServicePassword or
// $env:NEXUS_SERVICE_PASSWORD; absent both, and given an interactive window
// station, it falls back to `Read-Host -AsSecureString`. That prompt reads
// from the same stdin pipe this script already uses to answer -CleanInstall's
// "Type 'yes' to confirm" — by the time it fires, that pipe is at EOF, so it
// silently resolves to an empty password (any non-null SecureString is
// truthy in PowerShell, even an empty one, so this never reaches the
// script's own "no password -> run as LocalSystem" fallback branch). NSSM
// then installs the service with an empty credential, which fails at start
// with a Windows logon failure (seen live 2026-07-20: service left
// "Stopped", validation FAILED, no indication in the error that a password
// was the cause). Warn loudly here rather than silently hitting that later.
function warnIfServicePasswordMissing(): void {
  if (!process.env.NEXUS_SERVICE_PASSWORD) {
    const account = process.env.NEXUS_SERVICE_USERNAME || `${process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
    console.warn(
      `[nexus-install] WARNING: NEXUS_SERVICE_PASSWORD is not set. ${SETUP_SCRIPT} will very likely install ` +
        `the agent service under ${account} with an empty password and fail to start (Windows logon failure) ` +
        `— its own interactive password prompt reads from this script's piped stdin, which is already ` +
        `consumed by -CleanInstall's confirmation. Set NEXUS_SERVICE_PASSWORD=<${account}'s Windows account ` +
        `password> in .env to avoid this.`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// setup-service.ps1 hands NSSM the literal string "python" (its -Python
// default) as the service's executable, unresolved. NSSM stores that literal
// and Windows resolves it at *service* launch time, under the service-logon
// session for whichever account the service runs as — which does not
// inherit the interactive user's PATH (a per-user Python install commonly
// only reaches PATH via HKCU, loaded at interactive logon, not service
// logon). Result: "Failed to start service ... CreateProcess() failed: The
// system cannot find the file specified" even though `python --version`
// works fine in the very shell running this script (seen live 2026-07-20).
// Resolving the absolute path here, while still in that working interactive
// shell, and passing it via -Python sidesteps the bug without touching the
// Nexus codebase itself.
function resolvePythonExecutable(): string | undefined {
  try {
    const output = execFileSync('where', ['python'], {}).toString();
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined; // let setup-service.ps1's own "python" default + its own error surface instead
  }
}

// vision-agent dispatch is sandboxed (agents.vision.sandbox.enabled in the
// daemon's registry.yaml) and hard-requires a live container runtime before
// it processes anything — see docs/dev-feedback/03-vision-agent-sandbox-
// runtime-missing.md. Checking `<cmd> info`, not just PATH presence, catches
// the failure mode actually seen live: podman installed but its WSL machine
// not yet started ("podman info failed (exit 125): Cannot connect to
// Podman"), which looks identical to a dead pipeline from the test side
// (waitForSlugNote timing out at the full 10min POLL_TIMEOUT_MS) but is
// diagnosable in under a second here instead.
//
// Retries across attempts (not just across podman/docker within one attempt):
// a machine that's mid-boot when this check fires — e.g. `podman machine
// start` was run seconds ago — flaps from unreachable to reachable within a
// few seconds. A single-shot check would false-negative and fail the whole
// run over a timing race, not a real absence of the runtime.
export async function assertSandboxRuntimeAvailable(
  opts: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const cmd of ['podman', 'docker']) {
      try {
        execFileSync(cmd, ['info'], { stdio: 'ignore' });
        console.log(
          `[global-setup] sandbox runtime OK: \`${cmd} info\` succeeded` +
            (attempt > 1 ? ` (attempt ${attempt}/${attempts})` : '')
        );
        return;
      } catch {
        // try the next candidate, or the next attempt once both fail
      }
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(
    `No working container runtime found after ${attempts} attempts ` +
      '(checked: `podman info`, `docker info`). vision-agent dispatch is sandboxed and ' +
      'will fail every cycle without one, silently timing out every spec that waits on it. ' +
      'Start Podman (`podman machine start`) or Docker Desktop before running tests.'
  );
}

/** Uninstalls the service (if present) and wipes the codebase dir. */
export function clearInstall(): void {
  if (fs.existsSync(SETUP_SCRIPT)) {
    console.log('uninstalling existing service');
    assertElevated();
    run('pwsh', ['-File', SETUP_SCRIPT, '-Uninstall']);
  }
  if (fs.existsSync(NEXUS_PATH)) {
    console.log(`removing old codebase at ${NEXUS_PATH}`);
    removeDirWithRetry(NEXUS_PATH);
  }
}

/** Clones fresh and runs a clean install. Assumes clearInstall() already ran. */
export function installFresh(): void {
  console.log(`cloning ${REPO_URL} (${BRANCH}) into ${NEXUS_PATH}`);
  run('git', ['clone', '--branch', BRANCH, REPO_URL, NEXUS_PATH]);

  // setup-service.ps1's git health check fails with "dubious ownership" on
  // drives that don't record NTFS ownership (e.g. D:) unless this path is
  // explicitly trusted.
  run('git', ['config', '--global', '--add', 'safe.directory', NEXUS_PATH.replace(/\\/g, '/')]);

  // Must happen between clone and setup-service.ps1 — see the comment on
  // overrideAgentSchedules.
  overrideAgentSchedules();

  console.log(`running clean install (vault: ${VAULT_PATH})`);
  assertElevated();
  warnIfServicePasswordMissing();
  // -CleanInstall gates on an interactive `Read-Host "Type 'yes' to confirm"`
  // with no bypass flag — feed it via stdin so this works non-interactively.
  // -VaultRoot must be explicit: without it setup-service.ps1 defaults to
  // <ProjectRoot>\.knowledge-base, not VAULT_PATH — the daemon would then
  // watch a vault the tests never touch and every test would time out.
  // NEXUS_SERVICE_PASSWORD (if set) reaches setup-service.ps1 via inherited
  // env — execFileSync passes the full process.env through unless overridden.
  const args = ['-File', SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH];
  // -ServiceAccount defaults (in setup-service.ps1 itself) to the invoking
  // user — only pass it when the caller wants the service to run as someone
  // else. NEXUS_SERVICE_PASSWORD must still be that account's password.
  if (process.env.NEXUS_SERVICE_USERNAME) {
    args.push('-ServiceAccount', process.env.NEXUS_SERVICE_USERNAME);
  }
  const pythonPath = resolvePythonExecutable();
  if (pythonPath) {
    args.push('-Python', pythonPath);
  }
  run('pwsh', args, 'yes\n');
}

// Test-lane schedule: the stock registry ships 900s–86400s agent intervals,
// which is what makes the slow lane slow. Rewritten after clone and before
// setup-service.ps1 runs, because runner.py synthesizes each missing
// agent.json from registry.yaml at install time — editing the registry after
// install wouldn't take effect. `runtime` is left alone: its 60s value is the
// dispatch loop itself, not an agent cadence, and slowing it to 300s would
// add up to 5min of dispatch latency to every agent. `vision` gets its own
// (fast) override since almost every spec blocks on its draft note first —
// stacking the generic 300s default on top would tax every test, not just
// the @slow-agent ones.
export const AGENT_INTERVAL_OVERRIDES_S: Record<string, number> = {
  vision: Number(process.env.AGENT_INTERVAL_VISION_S ?? 90),
  repair: Number(process.env.AGENT_INTERVAL_REPAIR_S ?? 25 * 60),
  cleanup: Number(process.env.AGENT_INTERVAL_CLEANUP_S ?? 26 * 60),
};
export const DEFAULT_AGENT_INTERVAL_S = Number(process.env.AGENT_INTERVAL_DEFAULT_S ?? 5 * 60);

/** Parses `<agent>: interval_seconds` pairs out of the installed registry.yaml. */
export function readAgentIntervals(): Record<string, number> {
  const intervals: Record<string, number> = {};
  let agent = '';
  for (const line of fs.readFileSync(REGISTRY_PATH, 'utf-8').split('\n')) {
    const key = line.match(/^  ([\w-]+):\s*$/);
    if (key) agent = key[1];
    const m = line.match(/^\s+interval_seconds:\s*(\d+)\s*$/);
    if (m) intervals[agent] = Number(m[1]);
  }
  return intervals;
}

/** Rewrites every agent `interval_seconds:` in the cloned registry.yaml. */
export function overrideAgentSchedules(): void {
  const lines = fs.readFileSync(REGISTRY_PATH, 'utf-8').split('\n');
  let agent = '';
  let changed = 0;
  const out = lines.map((line) => {
    // Two-space-indented keys are the entries under `agents:` (and other
    // top-level maps, which have no interval_seconds and are unaffected).
    const key = line.match(/^  ([\w-]+):\s*$/);
    if (key) agent = key[1];
    const m = line.match(/^(\s+interval_seconds:\s*)\d+\s*$/);
    if (!m || agent === 'runtime') return line;
    changed++;
    return `${m[1]}${AGENT_INTERVAL_OVERRIDES_S[agent] ?? DEFAULT_AGENT_INTERVAL_S}`;
  });
  fs.writeFileSync(REGISTRY_PATH, out.join('\n'));
  console.log(
    `[global-setup] registry.yaml: overrode ${changed} interval_seconds ` +
      `(agents ${DEFAULT_AGENT_INTERVAL_S}s, vision ${AGENT_INTERVAL_OVERRIDES_S.vision}s, ` +
      `repair ${AGENT_INTERVAL_OVERRIDES_S.repair}s, cleanup ${AGENT_INTERVAL_OVERRIDES_S.cleanup}s)`
  );
}

const ENV_LOCAL_SKIP_DIRS = new Set(['node_modules', '.git']);

function findEnvLocalFiles(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ENV_LOCAL_SKIP_DIRS.has(entry.name)) continue;
      found.push(...findEnvLocalFiles(path.join(dir, entry.name), depth + 1));
    } else if (entry.name === '.env.local') {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Cheap post-install check for the 2026-07-09 perf review's suspected root
 * cause: -CleanInstall wipes every .env.local and nothing recreates them. If
 * vision-agent's credentials live in one, every scenario test times out
 * silently instead of erroring. Not confirmed, so this warns rather than
 * failing the run — see performance-review-notes.md, "Suspected root cause".
 */
export function warnIfEnvLocalMissing(): void {
  const found = findEnvLocalFiles(NEXUS_PATH);
  if (found.length === 0) {
    console.warn(
      `[global-setup] WARNING: no .env.local found anywhere under ${NEXUS_PATH} after install. ` +
        `-CleanInstall wipes .env.local and never recreates it — if the vision-agent's ` +
        `credentials live there, every scenario test will silently time out waiting for a ` +
        `daemon that can't authenticate.`
    );
  } else {
    console.log(`[global-setup] found ${found.length} .env.local file(s) under ${NEXUS_PATH}`);
  }
}
