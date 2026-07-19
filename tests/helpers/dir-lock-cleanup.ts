import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A prior interrupted run can leave something holding an open handle inside
// a target dir even with no service installed — observed 2026-07-19: an empty
// leftover dir, rmSync failing EPERM/"used by another process". Escalates
// through three stages, each only tried once the previous one has actually
// failed (never skips straight to the destructive end):
//   1. rmSync's own maxRetries/retryDelay — covers transient locks (AV scan).
//   2. 'wsl --shutdown' + retry — WSL's DrvFs cache keeps a handle into
//      /mnt/c paths after something in WSL touched them (root cause the one
//      time this was diagnosed live, via wslhost.exe).
//   3. find-and-kill the exact locking process via Sysinternals handle64.exe
//      (downloaded on demand, cached in os.tmpdir), then a final retry.
// Every stage logs before it acts — killing processes is a real side effect,
// this must never be a silent surprise.

/** Best-effort: true only if the shutdown command actually ran (wsl installed and reachable). */
function shutdownWsl(): boolean {
  try {
    execFileSync('wsl', ['--shutdown'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Restarting is best-effort and doesn't need to fail the caller — `wsl --shutdown`
// stops the whole WSL VM, not just the distro touching the target dir, so leaving it
// down would silently break any other WSL-dependent workflow the user has running.
function startWsl(): void {
  try {
    execFileSync('wsl', ['-e', 'true'], { stdio: 'ignore' });
  } catch {
    // no default distro, or already running — not our problem to fix
  }
}

// podman machine on Windows runs its VM inside WSL2 — `wsl --shutdown` takes it
// down too, which silently breaks the vision-agent's sandboxed dispatch (see
// project_qwen3_vl_preflight memory: podman/docker must be up for it to run).
// Both steps are best-effort: absent if podman/Podman Desktop isn't installed.
function restartPodman(): void {
  try {
    execFileSync('podman', ['machine', 'start'], { stdio: 'ignore' });
  } catch {
    // podman not installed, no machine configured, or already running
  }

  const desktopExe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'podman-desktop', 'Podman Desktop.exe');
  if (fs.existsSync(desktopExe)) {
    try {
      execFileSync('pwsh', ['-NoProfile', '-Command', `Start-Process -FilePath '${desktopExe}'`], { stdio: 'ignore' });
    } catch {
      // best effort
    }
  }
}

function isLockError(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'EPERM' || code === 'EBUSY';
}

const HANDLE_EXE_PATH = path.join(os.tmpdir(), 'nexus-testing-handle64.exe');
const HANDLE_LINE = /^(\S+)\s+pid:\s*(\d+)\s+type:\s*File/;

/** Best-effort: returns [] if handle64.exe can't be fetched or run, rather than failing the caller. */
function findLockingPids(dir: string): Array<{ name: string; pid: number }> {
  try {
    if (!fs.existsSync(HANDLE_EXE_PATH)) {
      execFileSync('pwsh', [
        '-Command',
        `Invoke-WebRequest -Uri 'https://live.sysinternals.com/handle64.exe' -OutFile '${HANDLE_EXE_PATH}' -UseBasicParsing`,
      ]);
    }
    const output = execFileSync(HANDLE_EXE_PATH, ['-accepteula', '-nobanner', dir], { encoding: 'utf-8' });
    return output
      .split('\n')
      .map((line) => line.match(HANDLE_LINE))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ name: m[1], pid: Number(m[2]) }));
  } catch {
    return [];
  }
}

/** Removes `dir`, escalating through wsl-shutdown/process-kill if something's holding it open. */
export function removeDirWithRetry(dir: string): void {
  let didShutdownWsl = false;
  try {
    removeDirWithRetryInner(dir, () => {
      didShutdownWsl = true;
    });
  } finally {
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
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      } catch {
        // already exited, or protected — best effort, move on
      }
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
