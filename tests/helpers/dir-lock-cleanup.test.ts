// Unit tests for dir-lock-cleanup.ts — verifies the escalation order (plain
// retry -> wsl shutdown -> kill holders -> wsl shutdown again -> final retry)
// and that wsl/podman get restarted exactly when wsl was actually shut down
// along the way. Mocks at the child_process/fs boundary rather than the os/*
// module exports: tsx compiles those to frozen ESM bindings that can't be
// reassigned (unlike node's builtin modules, see the require()-based trick
// below) — so this exercises the real os/wsl.ts, os/podman.ts,
// os/windows-processes.ts code, not stand-ins for it.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { removeDirWithRetry } from './dir-lock-cleanup';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsCjs = require('node:fs') as typeof import('node:fs');
const originalRmSync = fsCjs.rmSync;
const originalExistsSync = fsCjs.existsSync;

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
  fsCjs.rmSync = originalRmSync;
  fsCjs.existsSync = originalExistsSync;
});

interface ExecCall {
  cmd: string;
  args: string[];
}

function lockError(): NodeJS.ErrnoException {
  const err = new Error('EPERM: locked') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  return err;
}

// handle64.exe is cached at a computed tmp path — always "found" so
// findLockingPids skips the download branch. Podman Desktop's install path
// never matches, so restartPodman's desktop launch stays off unless a test
// overrides this.
function mockExistsSync(): void {
  fsCjs.existsSync = ((p: string) => String(p).includes('handle64')) as typeof originalExistsSync;
}

function mockExec(calls: ExecCall[], handler?: (call: ExecCall) => string | undefined): void {
  childProcessCjs.execFileSync = ((cmd: string, args: string[], options?: { encoding?: string }) => {
    const call = { cmd, args };
    calls.push(call);
    const result = handler?.(call) ?? '';
    // findLockingPids passes { encoding: 'utf-8' } and expects a string back;
    // every other caller here ignores the return value entirely.
    return options?.encoding ? result : Buffer.from(result);
  }) as unknown as typeof originalExecFileSync;
}

describe('removeDirWithRetry', () => {
  test('succeeds on the first plain rmSync — never touches wsl or podman', () => {
    let rmCalls = 0;
    fsCjs.rmSync = (() => {
      rmCalls++;
    }) as unknown as typeof originalRmSync;
    mockExistsSync();
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.doesNotThrow(() => removeDirWithRetry('C:\\some\\dir'));
    assert.equal(rmCalls, 1);
    assert.equal(calls.length, 0);
  });

  test('recovers after one wsl shutdown, then restarts wsl and podman afterward', () => {
    let rmCallCount = 0;
    fsCjs.rmSync = (() => {
      rmCallCount++;
      if (rmCallCount === 1) throw lockError();
    }) as unknown as typeof originalRmSync;
    mockExistsSync();
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.doesNotThrow(() => removeDirWithRetry('C:\\some\\dir'));
    assert.equal(rmCallCount, 2);
    assert.deepEqual(
      calls.map((c) => `${c.cmd} ${c.args.join(' ')}`),
      ['wsl --shutdown', 'wsl -e true', 'podman machine start']
    );
  });

  test('escalates to killing holders when wsl shutdown alone is not enough', () => {
    let rmCallCount = 0;
    fsCjs.rmSync = (() => {
      rmCallCount++;
      if (rmCallCount < 3) throw lockError();
    }) as unknown as typeof originalRmSync;
    mockExistsSync();
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd.includes('handle64')) return 'Code.exe            pid: 999  type: File           1A4: C:\\some\\dir\n';
    });

    assert.doesNotThrow(() => removeDirWithRetry('C:\\some\\dir'));
    assert.equal(rmCallCount, 3);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls[0], { cmd: 'wsl', args: ['--shutdown'] });
    assert.ok(calls[1].cmd.includes('handle64'));
    assert.deepEqual(calls[2], { cmd: 'taskkill', args: ['/F', '/PID', '999'] });
    assert.deepEqual(calls[3], { cmd: 'wsl', args: ['--shutdown'] });
    assert.deepEqual(calls[4], { cmd: 'wsl', args: ['-e', 'true'] });
    assert.deepEqual(calls[5], { cmd: 'podman', args: ['machine', 'start'] });
  });

  test('throws naming the holders when still locked after every stage, but still restarts wsl/podman', () => {
    fsCjs.rmSync = (() => {
      throw lockError();
    }) as unknown as typeof originalRmSync;
    mockExistsSync();
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd.includes('handle64')) return 'Code.exe            pid: 999  type: File           1A4: C:\\some\\dir\n';
    });

    assert.throws(() => removeDirWithRetry('C:\\some\\dir'), /Code\.exe \(pid 999\)/);
    // wsl was shut down along the way — must still be restarted even though removal ultimately failed.
    const cmds = calls.map((c) => c.cmd);
    assert.deepEqual(cmds.slice(-2), ['wsl', 'podman']);
    assert.deepEqual(calls[calls.length - 2].args, ['-e', 'true']);
    assert.deepEqual(calls[calls.length - 1].args, ['machine', 'start']);
  });

  test('rethrows non-lock errors immediately without any escalation', () => {
    fsCjs.rmSync = (() => {
      throw new Error('disk full');
    }) as unknown as typeof originalRmSync;
    mockExistsSync();
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.throws(() => removeDirWithRetry('C:\\some\\dir'), /disk full/);
    assert.equal(calls.length, 0);
  });
});
