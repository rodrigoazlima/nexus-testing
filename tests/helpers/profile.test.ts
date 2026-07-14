// Unit test for the resource-report math in profile.ts — pure data in,
// stats out; no sampler process, no filesystem.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type Marker, type Sample } from './profile';

const sample = (ts: number, cpu: number): Sample => ({
  ts,
  cpu,
  memUsed: 2 * 2 ** 30,
  memTotal: 8 * 2 ** 30,
});

describe('summarize', () => {
  test('slices samples per phase and counts overlapping tests leniently', () => {
    const samples = [sample(0, 10), sample(1000, 20), sample(2000, 90), sample(3000, 50)];
    const markers: Marker[] = [
      { ts: 0, phase: 'install', event: 'start' },
      { ts: 1000, phase: 'install', event: 'end' },
      { ts: 1000, phase: 'test:a', event: 'start' },
      { ts: 3000, phase: 'test:a', event: 'end', label: 'passed' },
      { ts: 2000, phase: 'test:b', event: 'start' },
      { ts: 3000, phase: 'test:b', event: 'end', label: 'failed' },
    ];

    const stats = summarize(samples, markers);

    const install = stats.find((p) => p.phase === 'install');
    assert.equal(install?.samples, 2);
    assert.equal(install?.cpuAvg, 15);
    assert.equal(install?.concurrent, 0);

    const a = stats.find((p) => p.phase === 'test:a');
    assert.equal(a?.cpuMax, 90);
    assert.equal(a?.label, 'passed');
    assert.equal(a?.concurrent, 1); // test:b overlaps — reported, not attributed

    assert.deepEqual(
      stats.map((p) => p.phase),
      ['install', 'test:a', 'test:b'] // sorted by start time
    );
  });

  test('closes a phase missing its end marker at the last sample instead of dropping it', () => {
    const samples = [sample(0, 10), sample(5000, 30)];
    const markers: Marker[] = [{ ts: 0, phase: 'test:crashed', event: 'start' }];

    const [crashed] = summarize(samples, markers);
    assert.equal(crashed.endTs, 5000);
    assert.equal(crashed.samples, 2);
  });
});
