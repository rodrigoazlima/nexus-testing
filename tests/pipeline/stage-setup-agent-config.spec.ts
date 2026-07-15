import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { POLL_INTERVAL_MS } from '../helpers/config';
import {
  NEXUS_PATH,
  AGENT_INTERVAL_OVERRIDES_S,
  DEFAULT_AGENT_INTERVAL_S,
  readAgentIntervals,
} from '../helpers/nexus-install';

// Validates what global-setup's fresh install produced: every agent interval
// in registry.yaml carries the overrideAgentSchedules test-lane values.
// agent.json itself isn't synthesized at install time — runner.py only
// writes it on the daemon's first initialization run — so the existence
// check has to wait out that first run (runtime's 60s dispatch loop) rather
// than reading it as a pure fast-lane filesystem check.
test.describe.serial('stage: installed agent schedule config', () => {
  test('registry.yaml intervals match the test-lane overrides', () => {
    const intervals = readAgentIntervals();
    const { runtime, ...agents } = intervals;
    console.log(`[stage-setup-agent-config] registry intervals: ${JSON.stringify(intervals)}`);

    expect(runtime, 'runtime is the dispatch loop itself and must stay at 60s').toBe(60);
    expect(Object.keys(agents).length, 'active agents with an interval in registry.yaml').toBeGreaterThan(0);
    for (const [agent, interval] of Object.entries(agents)) {
      const expected = AGENT_INTERVAL_OVERRIDES_S[agent] ?? DEFAULT_AGENT_INTERVAL_S;
      expect(interval, `${agent} interval_seconds — expected ${expected}, actual ${interval}`).toBe(expected);
    }
  });

  test('agent.json does not exist right after install (runner hasn\'t run yet)', async () => {
    const intervals = readAgentIntervals();
    const agents = Object.keys(intervals).filter((agent) => agent !== 'runtime');

    for (const agent of agents) {
      const agentJsonPath = path.join(NEXUS_PATH, 'agents', agent, 'agent.json');
      const raw = await fs.readFile(agentJsonPath, 'utf-8').catch(() => null);
      expect(raw, `${agentJsonPath} must not exist after install (runner didn't run yet)`).toBeNull();
    }
  });

  // ponytail: 2min ceiling — runtime's dispatch loop is fixed at 60s (see
  // overrideAgentSchedules), so the first initialization run is due well
  // inside that window.
  test('every agent.json exists and agrees with the registry after the runner\'s first initialization run', async () => {
    const intervals = readAgentIntervals();
    const agents = Object.keys(intervals).filter((agent) => agent !== 'runtime');

    for (const agent of agents) {
      const agentJsonPath = path.join(NEXUS_PATH, 'agents', agent, 'agent.json');
      let raw: string | null = null;

      await expect(async () => {
        raw = await fs.readFile(agentJsonPath, 'utf-8').catch(() => null);
        expect(raw, `${agentJsonPath} must exist after first initialization run (runner.py synthesizes it)`).not.toBeNull();
      }).toPass({ timeout: 2 * 60_000, intervals: [POLL_INTERVAL_MS] });

      const { tasks } = JSON.parse(raw!) as { tasks: Record<string, { intervalSeconds: number }> };
      expect(Object.keys(tasks).length, `${agent}: tasks in agent.json`).toBeGreaterThan(0);
      for (const [taskId, task] of Object.entries(tasks)) {
        console.log(
          `[stage-setup-agent-config] ${agent}/${taskId} — expected intervalSeconds=${intervals[agent]}, actual=${task.intervalSeconds}`
        );
        expect(task.intervalSeconds, `${agent}/${taskId} intervalSeconds`).toBe(intervals[agent]);
      }
    }
  });
});
