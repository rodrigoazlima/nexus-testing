// Unit tests for os/wsl.ts — verifies shutdownWsl/startWsl invoke the right
// wsl CLI incantations and swallow failures, without ever touching a real
// WSL install. Run with: npm run test:unit.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { shutdownWsl, startWsl } from './os/wsl';

// require(), not import: node:child_process's ESM named exports are
// non-configurable live-binding getters that mock.method can't patch, but
// they read through to this same CJS exports object — mutating a property
// here is what os/wsl.ts's `import { execFileSync }` actually sees.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
});

interface ExecCall {
  cmd: string;
  args: string[];
}

function mockExec(calls: ExecCall[], onCall?: (call: ExecCall) => void): void {
  childProcessCjs.execFileSync = ((cmd: string, args: string[]) => {
    const call = { cmd, args };
    calls.push(call);
    onCall?.(call);
    return Buffer.from('');
  }) as unknown as typeof originalExecFileSync;
}

describe('shutdownWsl', () => {
  test('runs wsl --shutdown and returns true on success', () => {
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.equal(shutdownWsl(), true);
    assert.deepEqual(calls, [{ cmd: 'wsl', args: ['--shutdown'] }]);
  });

  test('returns false when wsl is not installed/reachable', () => {
    const calls: ExecCall[] = [];
    mockExec(calls, () => {
      throw new Error('not found');
    });

    assert.equal(shutdownWsl(), false);
  });
});

describe('startWsl', () => {
  test('runs wsl -e true', () => {
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.doesNotThrow(() => startWsl());
    assert.deepEqual(calls, [{ cmd: 'wsl', args: ['-e', 'true'] }]);
  });

  test('swallows failure (no default distro, or already running)', () => {
    const calls: ExecCall[] = [];
    mockExec(calls, () => {
      throw new Error('no distro');
    });

    assert.doesNotThrow(() => startWsl());
  });
});
