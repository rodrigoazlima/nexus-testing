import { execFileSync } from 'node:child_process';

/** Best-effort: true only if the shutdown command actually ran (wsl installed and reachable). */
export function shutdownWsl(): boolean {
  try {
    execFileSync('wsl', ['--shutdown'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Restarting is best-effort and doesn't need to fail the caller — `wsl --shutdown`
// stops the whole WSL VM, not just whatever distro triggered the shutdown, so
// leaving it down would silently break any other WSL-dependent workflow the
// user has running.
export function startWsl(): void {
  try {
    execFileSync('wsl', ['-e', 'true'], { stdio: 'ignore' });
  } catch {
    // no default distro, or already running — not our problem to fix
  }
}
