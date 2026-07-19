import fs from 'node:fs';
import { restartPodman } from './os/podman';
import { findLockingPids, killProcess } from './os/processes';
import { shutdownWsl, startWsl } from './os/wsl';

// A prior interrupted run can leave something holding an open handle inside
// a target dir even with no service installed — observed 2026-07-19: an empty
// leftover dir, rmSync failing EPERM/"used by another process". Escalates
// through three stages, each only tried once the previous one has actually
// failed (never skips straight to the destructive end):
//   1. rmSync's own maxRetries/retryDelay — covers transient locks (AV scan).
//   2. 'wsl --shutdown' (os/wsl.ts) + retry — WSL's DrvFs cache keeps a handle
//      into /mnt/c paths after something in WSL touched them (root cause the
//      one time this was diagnosed live, via wslhost.exe).
//   3. find-and-kill the exact locking process (os/processes.ts — handle64.exe
//      + taskkill on Windows, lsof + kill on Linux), then a final retry.
// Every stage logs before it acts — killing processes is a real side effect,
// this must never be a silent surprise.

function isLockError(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'EPERM' || code === 'EBUSY';
}

/** Removes `dir`, escalating through wsl-shutdown/process-kill if something's holding it open. */
export function removeDirWithRetry(dir: string): void {
  let didShutdownWsl = false;
  try {
    removeDirWithRetryInner(dir, () => {
      didShutdownWsl = true;
    });
  } finally {
    // wsl/podman restart must run even if the dir is still locked afterward —
    // we only shut them down as a side effect of trying, they don't get to
    // stay down just because the actual removal failed.
    if (didShutdownWsl) {
      startWsl();
      restartPodman();
    }
  }
}

function removeDirWithRetryInner(dir: string, onWslShutdown: () => void): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return;
  } catch (err) {
    if (!isLockError(err)) throw err;
  }

  console.log(`${dir} still locked after retrying — running 'wsl --shutdown' to release any WSL-held handle`);
  if (shutdownWsl()) onWslShutdown();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return;
  } catch (err) {
    if (!isLockError(err)) throw err;
  }

  const holders = findLockingPids(dir);
  if (holders.length > 0) {
    console.log(`${dir} still locked — killing locking process(es): ${holders.map((h) => `${h.name} (pid ${h.pid})`).join(', ')}`);
    for (const { pid } of holders) {
      killProcess(pid);
    }
  }

  // Killing the Windows-side holders can still leave WSL's DrvFs cache
  // holding its own handle into the same /mnt/c path (it re-caches on any
  // WSL-side touch, including ones triggered by the processes just killed) —
  // shut it down a second time before the final retry.
  if (shutdownWsl()) onWslShutdown();

  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  } catch (err) {
    if (!isLockError(err)) throw err;
    throw new Error(
      `${dir} is still locked after 'wsl --shutdown' (x2) and killing ` +
        `${holders.length > 0 ? holders.map((h) => `${h.name} (pid ${h.pid})`).join(', ') : '(no locking process found — handle64.exe unavailable or found nothing)'}. ` +
        `Close any terminal/Explorer window whose cwd is inside ${dir} and retry. Original error: ${err}`
    );
  }
}
