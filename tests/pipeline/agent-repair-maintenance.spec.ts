import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { copyNexusDiagnostics } from '../helpers/vault-utils';
import { REPORTS_DIR } from '../helpers/nexus-state';

// repair-agent runs every 86400s (registry.yaml) — far past the suite's
// normal 10min test timeout, and there's no in-scope way to force-trigger it.
// Tagged @slow-agent (see package.json test:pipeline:fast/:slow); this test
// ties up a worker for ~24h, run it standalone/off-hours, not in a normal
// `npm test`.
//
// repair-agent is content-agnostic maintenance (stale locks, missing dirs,
// orphan refs) — nothing here is derived from an image-tags test, there's no
// image-content angle to expand.
test.describe.serial(
  'repair-agent: daily maintenance cycle refreshes its report',
  { tag: '@slow-agent' },
  () => {
    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus) {
        const dir = path.join(__dirname, '..', '..', 'tmp', `repair-maintenance-${Date.now()}`);
        await fs.mkdir(dir, { recursive: true });
        await copyNexusDiagnostics(dir);
        console.log(`[agent-repair-maintenance] FAILED — diagnostics copied to ${dir}`);
      }
    });

    test('repair-{today}.json is refreshed after waiting out a full cycle', async () => {
      test.setTimeout(25 * 60 * 60_000);

      const startTime = Date.now();
      const today = new Date().toISOString().slice(0, 10);
      const reportPath = path.join(REPORTS_DIR, `repair-${today}.json`);

      await expect(async () => {
        const stat = await fs.stat(reportPath);
        expect(
          stat.mtimeMs,
          `${reportPath} must have a fresh mtime from a repair cycle that ran during this test`
        ).toBeGreaterThanOrEqual(startTime);
      }).toPass({ timeout: 24.5 * 60 * 60_000, intervals: [5 * 60_000] });
    });
  }
);
