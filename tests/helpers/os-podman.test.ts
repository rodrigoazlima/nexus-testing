// Unit tests for os/podman.ts — verifies restartPodman starts the podman
// machine and launches Podman Desktop (via a detached spawn, never a blocking
// call) only when it's actually installed, on both the Windows and Linux
// discovery paths, without ever touching a real podman/Podman Desktop install.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { restartPodman } from './os/podman';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;
const originalSpawn = childProcessCjs.spawn;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsCjs = require('node:fs') as typeof import('node:fs');
const originalExistsSync = fsCjs.existsSync;
const originalPlatform = process.platform;

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
  childProcessCjs.spawn = originalSpawn;
  fsCjs.existsSync = originalExistsSync;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  Object.defineProperty(process, 'platform', { value: platform });
  fn();
}

interface ExecCall {
  cmd: string;
  args: string[];
}
interface SpawnCall {
  cmd: string;
  args: string[];
  options?: Record<string, unknown>;
}

function mockExec(calls: ExecCall[], onCall?: (call: ExecCall) => void): void {
  childProcessCjs.execFileSync = ((cmd: string, args: string[]) => {
    const call = { cmd, args };
    calls.push(call);
    onCall?.(call);
    return Buffer.from('');
  }) as unknown as typeof originalExecFileSync;
}

function mockSpawn(calls: SpawnCall[]): void {
  childProcessCjs.spawn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    return { unref: () => {} } as unknown as ReturnType<typeof originalSpawn>;
  }) as unknown as typeof originalSpawn;
}

describe('restartPodman', () => {
  test('starts the podman machine', () => {
    const execCalls: ExecCall[] = [];
    mockExec(execCalls);
    fsCjs.existsSync = (() => false) as typeof originalExistsSync;

    restartPodman();

    assert.deepEqual(execCalls[0], { cmd: 'podman', args: ['machine', 'start'] });
  });

  test('swallows failure when podman is not installed', () => {
    mockExec([], () => {
      throw new Error('not found');
    });
    fsCjs.existsSync = (() => false) as typeof originalExistsSync;

    assert.doesNotThrow(() => restartPodman());
  });

  test('does nothing on an unsupported platform (e.g. macOS)', () => {
    withPlatform('darwin', () => {
      mockExec([]);
      const spawnCalls: SpawnCall[] = [];
      mockSpawn(spawnCalls);
      fsCjs.existsSync = (() => true) as typeof originalExistsSync; // even if something "exists", macOS isn't handled

      restartPodman();

      assert.equal(spawnCalls.length, 0);
    });
  });

  describe('on Windows', () => {
    test('launches Podman Desktop via detached spawn when found at the standard install path', () => {
      withPlatform('win32', () => {
        mockExec([]);
        const spawnCalls: SpawnCall[] = [];
        mockSpawn(spawnCalls);
        fsCjs.existsSync = ((p: string) => String(p).includes('Podman Desktop.exe')) as typeof originalExistsSync;

        restartPodman();

        assert.equal(spawnCalls.length, 1);
        assert.ok(spawnCalls[0].cmd.includes('Podman Desktop.exe'));
        assert.equal(spawnCalls[0].options?.detached, true);
      });
    });

    test('does not launch when Podman Desktop is not installed', () => {
      withPlatform('win32', () => {
        mockExec([]);
        const spawnCalls: SpawnCall[] = [];
        mockSpawn(spawnCalls);
        fsCjs.existsSync = (() => false) as typeof originalExistsSync;

        restartPodman();

        assert.equal(spawnCalls.length, 0);
      });
    });
  });

  describe('on Linux', () => {
    test('launches via a known binary path when present', () => {
      withPlatform('linux', () => {
        mockExec([]);
        const spawnCalls: SpawnCall[] = [];
        mockSpawn(spawnCalls);
        fsCjs.existsSync = ((p: string) => p === '/usr/bin/podman-desktop') as typeof originalExistsSync;

        restartPodman();

        assert.deepEqual(spawnCalls[0], { cmd: '/usr/bin/podman-desktop', args: [], options: { detached: true, stdio: 'ignore' } });
      });
    });

    test('falls back to flatpak when no binary is found but flatpak has it installed', () => {
      withPlatform('linux', () => {
        // default mockExec never throws, i.e. `flatpak info ...` "succeeds"
        mockExec([]);
        const spawnCalls: SpawnCall[] = [];
        mockSpawn(spawnCalls);
        fsCjs.existsSync = (() => false) as typeof originalExistsSync;

        restartPodman();

        assert.deepEqual(spawnCalls[0], {
          cmd: 'flatpak',
          args: ['run', 'io.podman_desktop.PodmanDesktop'],
          options: { detached: true, stdio: 'ignore' },
        });
      });
    });

    test('does nothing when neither a binary nor flatpak is found', () => {
      withPlatform('linux', () => {
        mockExec([], (call) => {
          if (call.cmd === 'flatpak') throw new Error('not installed');
        });
        const spawnCalls: SpawnCall[] = [];
        mockSpawn(spawnCalls);
        fsCjs.existsSync = (() => false) as typeof originalExistsSync;

        assert.doesNotThrow(() => restartPodman());
        assert.equal(spawnCalls.length, 0);
      });
    });
  });

  test('swallows failure from the detached spawn itself', () => {
    withPlatform('win32', () => {
      mockExec([]);
      childProcessCjs.spawn = (() => {
        throw new Error('spawn failed');
      }) as unknown as typeof originalSpawn;
      fsCjs.existsSync = (() => true) as typeof originalExistsSync;

      assert.doesNotThrow(() => restartPodman());
    });
  });
});
