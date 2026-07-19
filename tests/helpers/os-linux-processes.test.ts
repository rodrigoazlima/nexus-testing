// Unit tests for os/linux-processes.ts — verifies lsof -Fpc output parsing
// and `kill -9` invocation, without ever running a real lsof/kill.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findLockingPids, killProcess } from './os/linux-processes';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
});

// lsof -Fpc field-output: 'p<pid>' starts a process record, 'c<command>'
// names it, repeated once per open file under the scanned directory.
const SAMPLE_LSOF_OUTPUT = `p21488
ccode
p21488
ccode
p30996
cbash
`;

describe('findLockingPids', () => {
  test('parses p/c field pairs into name/pid pairs', () => {
    childProcessCjs.execFileSync = (() => SAMPLE_LSOF_OUTPUT) as unknown as typeof originalExecFileSync;

    const holders = findLockingPids('/some/dir');

    assert.deepEqual(holders, [
      { name: 'code', pid: 21488 },
      { name: 'code', pid: 21488 },
      { name: 'bash', pid: 30996 },
    ]);
  });

  test('returns [] when lsof is not installed', () => {
    childProcessCjs.execFileSync = (() => {
      throw new Error('command not found');
    }) as unknown as typeof originalExecFileSync;

    assert.deepEqual(findLockingPids('/some/dir'), []);
  });

  test('returns [] when lsof exits non-zero (nothing under dir is open)', () => {
    childProcessCjs.execFileSync = (() => {
      const err = new Error('lsof: status 1') as NodeJS.ErrnoException;
      throw err;
    }) as unknown as typeof originalExecFileSync;

    assert.deepEqual(findLockingPids('/some/dir'), []);
  });
});

describe('killProcess', () => {
  test('runs kill -9 <pid>', () => {
    const calls: string[][] = [];
    childProcessCjs.execFileSync = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return Buffer.from('');
    }) as unknown as typeof originalExecFileSync;

    killProcess(1234);

    assert.deepEqual(calls, [['kill', '-9', '1234']]);
  });

  test('swallows failure (already exited, or not ours to kill)', () => {
    childProcessCjs.execFileSync = (() => {
      throw new Error('operation not permitted');
    }) as unknown as typeof originalExecFileSync;

    assert.doesNotThrow(() => killProcess(1234));
  });
});
