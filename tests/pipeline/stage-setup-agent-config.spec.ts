import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  NEXUS_PATH,
  AGENT_INTERVAL_OVERRIDES_S,
  DEFAULT_AGENT_INTERVAL_S,
  readAgentIntervals,
} from '../helpers/nexus-install';

// Validates what global-setup's fresh install produced: every agent interval
// in registry.yaml carries the overrideAgentSchedules test-lane values, and
// the agent.json files runner.py synthesized from that registry agree with
// it. Pure filesystem reads against NEXUS_PATH — no daemon wait, fast lane.
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

  test('every agent.json synthesized from the registry agrees with it', async () => {
    const intervals = readAgentIntervals();
    const agents = Object.keys(intervals).filter((agent) => agent !== 'runtime');

    for (const agent of agents) {
      const agentJsonPath = path.join(NEXUS_PATH, 'agents', agent, 'agent.json');
      const raw = await fs.readFile(agentJsonPath, 'utf-8').catch(() => null);
      expect(raw, `${agentJsonPath} must exist after install (runner.py synthesizes it)`).not.toBeNull();

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
