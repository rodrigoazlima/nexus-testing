import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, VAULT_PATH } from './config';

// NTFS required — setup-service.ps1 links agents via junctions, which exFAT
// doesn't support ("Incorrect function" on creation). Default resolves under
// ROOT_DIR (not cwd) so it lands on whatever drive the repo itself is
// checked out on, regardless of invocation directory.
export const NEXUS_PATH = path.resolve(process.env.NEXUS_PATH ?? path.join(ROOT_DIR, '.testing', 'nexus'));
export const REPO_URL = 'https://github.com/rodrigoazlima/NexusCampaigns.git';
// Lets a run target a feature branch of Nexus (e.g. to test against
// in-progress agent changes) without editing this file. Read once at module
// load, same as NEXUS_PATH/VAULT_PATH above — set NEXUS_BRANCH in .env.
export const BRANCH = process.env.NEXUS_BRANCH ?? 'master';
export const SETUP_SCRIPT = path.join(NEXUS_PATH, 'agents', 'runtime', 'tools', 'setup-service.ps1');
export const REGISTRY_PATH = path.join(NEXUS_PATH, 'agents', 'registry.yaml');

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

/** Uninstalls the service (if present) and wipes the codebase dir. */
export function clearInstall(): void {
  if (fs.existsSync(SETUP_SCRIPT)) {
    console.log('uninstalling existing service');
    assertElevated();
    run('pwsh', ['-File', SETUP_SCRIPT, '-Uninstall']);
  }
  if (fs.existsSync(NEXUS_PATH)) {
    console.log(`removing old codebase at ${NEXUS_PATH}`);
    fs.rmSync(NEXUS_PATH, { recursive: true, force: true });
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
  // -CleanInstall gates on an interactive `Read-Host "Type 'yes' to confirm"`
  // with no bypass flag — feed it via stdin so this works non-interactively.
  // -VaultRoot must be explicit: without it setup-service.ps1 defaults to
  // <ProjectRoot>\.knowledge-base, not VAULT_PATH — the daemon would then
  // watch a vault the tests never touch and every test would time out.
  run('pwsh', ['-File', SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH], 'yes\n');
}

// Test-lane schedule: the stock registry ships 900s–86400s agent intervals,
// which is what makes the slow lane slow. Rewritten after clone and before
// setup-service.ps1 runs, because runner.py synthesizes each missing
// agent.json from registry.yaml at install time — editing the registry after
// install wouldn't take effect. `runtime` is left alone: its 60s value is the
// dispatch loop itself, not an agent cadence, and slowing it to 300s would
// add up to 5min of dispatch latency to every agent.
export const AGENT_INTERVAL_OVERRIDES_S: Record<string, number> = {
  repair: 25 * 60,
  cleanup: 26 * 60,
};
export const DEFAULT_AGENT_INTERVAL_S = 5 * 60;

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
      `(agents ${DEFAULT_AGENT_INTERVAL_S}s, repair ${AGENT_INTERVAL_OVERRIDES_S.repair}s, ` +
      `cleanup ${AGENT_INTERVAL_OVERRIDES_S.cleanup}s)`
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
