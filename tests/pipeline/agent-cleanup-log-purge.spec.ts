import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { copyNexusDiagnostics, registerCreatedPaths } from '../helpers/vault-utils';
import { createStaleLogFixture } from '../helpers/nexus-state';

// cleanup-agent's interval is overridden to 1560s (26min) at install time
// (overrideAgentSchedules, helpers/nexus-install.ts) — still past the suite's
// normal 10min test timeout, and there's no in-scope way to force-trigger it.
// Tagged @slow-agent (see package.json test:pipeline:fast/:slow); this test
// ties up a worker for up to ~1h, keep it out of a normal `npm test`.
//
// cleanup-agent is content-agnostic maintenance (purges old logs/reports) —
// nothing here is derived from an image-tags test. Crucially, this creates
// its OWN backdated dummy log file rather than relying on real production
// logs being old enough to purge — never touch real log history.
test.describe.serial(
  'cleanup-agent: our own stale log fixture gets purged',
  { tag: '@slow-agent' },
  () => {
    let logPath: string;

    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus) {
        const dir = path.join(__dirname, '..', '..', 'tmp', `cleanup-log-purge-${Date.now()}`);
        await fs.mkdir(dir, { recursive: true });
        await copyNexusDiagnostics(dir);
        console.log(`[agent-cleanup-log-purge] FAILED — diagnostics copied to ${dir}`);
      }
    });

    test.afterAll(async () => {
      // If cleanup-agent never ran (or this test failed early), make sure our
      // own fixture doesn't linger — hand it to the shared exclusion registry
      // (stage-inbox-exclusion.spec.ts drains it) instead of deleting here.
      await registerCreatedPaths([logPath]);
    });

    test('our backdated dummy log file is purged by the next cleanup cycle', async () => {
      test.setTimeout(60 * 60_000);

      logPath = await createStaleLogFixture();

      await expect(async () => {
        await expect(fs.access(logPath)).rejects.toThrow();
      }).toPass({ timeout: 55 * 60_000, intervals: [60_000] });
    });
  }
);
