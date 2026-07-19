// Unit tests for os/windows-processes.ts — verifies handle64.exe output
// parsing and taskkill invocation, without ever downloading/running the real
// Sysinternals tool or killing a real process.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findLockingPids, killProcess } from './os/windows-processes';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsCjs = require('node:fs') as typeof import('node:fs');
const originalExistsSync = fsCjs.existsSync;

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
  fsCjs.existsSync = originalExistsSync;
});

const SAMPLE_HANDLE_OUTPUT = `
Code.exe            pid: 21488  type: File           1A4: C:\\opt\\GitHub\\nexus-testing\\.testing\\nexus
Code.exe            pid: 21488  type: File           220: C:\\opt\\GitHub\\nexus-testing\\.testing\\nexus\\agents
node.exe            pid: 17032  type: Section        3AC: C:\\opt\\GitHub\\nexus-testing\\.testing\\nexus
cmd.exe             pid: 30996  type: File           4F0: C:\\opt\\GitHub\\nexus-testing\\.testing\\nexus\\system
`;

describe('findLockingPids', () => {
  test('parses File-type handle lines into name/pid pairs, skipping non-File types', () => {
    fsCjs.existsSync = (() => true) as typeof originalExistsSync; // skip the handle64.exe download branch
    childProcessCjs.execFileSync = (() => SAMPLE_HANDLE_OUTPUT) as unknown as typeof originalExecFileSync;

    const holders = findLockingPids('C:\\opt\\GitHub\\nexus-testing\\.testing\\nexus');

    assert.deepEqual(holders, [
      { name: 'Code.exe', pid: 21488 },
      { name: 'Code.exe', pid: 21488 },
      { name: 'cmd.exe', pid: 30996 },
    ]);
  });

  test('returns [] when handle64.exe fails to run', () => {
    fsCjs.existsSync = (() => true) as typeof originalExistsSync;
    childProcessCjs.execFileSync = (() => {
      throw new Error('boom');
    }) as unknown as typeof originalExecFileSync;

    assert.deepEqual(findLockingPids('C:\\some\\dir'), []);
  });

  test('downloads handle64.exe first when not already cached', () => {
    fsCjs.existsSync = (() => false) as typeof originalExistsSync;
    const calls: string[][] = [];
    childProcessCjs.execFileSync = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return calls.length === 1 ? Buffer.from('') : SAMPLE_HANDLE_OUTPUT;
    }) as unknown as typeof originalExecFileSync;

    findLockingPids('C:\\some\\dir');

    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'pwsh');
    assert.ok(calls[0].some((a) => a.includes('live.sysinternals.com/handle64.exe')));
  });
});

describe('killProcess', () => {
  test('runs taskkill /F /PID <pid>', () => {
    const calls: string[][] = [];
    childProcessCjs.execFileSync = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return Buffer.from('');
    }) as unknown as typeof originalExecFileSync;

    killProcess(1234);

    assert.deepEqual(calls, [['taskkill', '/F', '/PID', '1234']]);
  });

  test('swallows failure (already exited, or protected)', () => {
    childProcessCjs.execFileSync = (() => {
      throw new Error('access denied');
    }) as unknown as typeof originalExecFileSync;

    assert.doesNotThrow(() => killProcess(1234));
  });
});
