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
export const BRANCH = 'master';
export const SETUP_SCRIPT = path.join(NEXUS_PATH, 'agents', 'runtime', 'tools', 'setup-service.ps1');

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

/** Uninstalls the service (if present) and wipes the codebase dir. */
export function clearInstall(): void {
  if (fs.existsSync(SETUP_SCRIPT)) {
    console.log('uninstalling existing service');
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

  console.log(`running clean install (vault: ${VAULT_PATH})`);
  // -CleanInstall gates on an interactive `Read-Host "Type 'yes' to confirm"`
  // with no bypass flag — feed it via stdin so this works non-interactively.
  // -VaultRoot must be explicit: without it setup-service.ps1 defaults to
  // <ProjectRoot>\.knowledge-base, not VAULT_PATH — the daemon would then
  // watch a vault the tests never touch and every test would time out.
  run('pwsh', ['-File', SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH], 'yes\n');
}
