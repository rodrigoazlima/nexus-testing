import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// podman machine on Windows/macOS runs its VM inside WSL2/HyperKit — shutting
// that down (see wsl.ts) takes it down too, which silently breaks the
// vision-agent's sandboxed dispatch (see project_qwen3_vl_preflight memory:
// podman/docker must be up for it to run). On native Linux podman runs
// directly on the host kernel with no machine to restart — this is a harmless
// no-op there (caught below). Both steps are best-effort either way: absent
// if podman/Podman Desktop isn't installed.
export function restartPodman(): void {
  try {
    execFileSync('podman', ['machine', 'start'], { stdio: 'ignore' });
  } catch {
    // podman not installed, no machine configured/needed, or already running
  }

  launchPodmanDesktop();
}

// spawn (not execFileSync) so we don't block on a GUI app that's meant to
// keep running after we return.
function launchDetached(cmd: string, args: string[] = []): void {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // best effort
  }
}

function launchPodmanDesktop(): void {
  if (process.platform === 'win32') {
    const desktopExe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'podman-desktop', 'Podman Desktop.exe');
    if (fs.existsSync(desktopExe)) launchDetached(desktopExe);
    return;
  }

  if (process.platform !== 'linux') return;

  // ponytail: covers the two common Linux install shapes (direct binary,
  // flatpak); add more (snap, AppImage path) only if this misses in practice.
  const knownBinaryPaths = ['/usr/bin/podman-desktop', '/opt/podman-desktop/podman-desktop'];
  const binary = knownBinaryPaths.find((p) => fs.existsSync(p));
  if (binary) {
    launchDetached(binary);
    return;
  }

  try {
    execFileSync('flatpak', ['info', 'io.podman_desktop.PodmanDesktop'], { stdio: 'ignore' });
    launchDetached('flatpak', ['run', 'io.podman_desktop.PodmanDesktop']);
  } catch {
    // not installed via flatpak either — nothing to launch
  }
}
