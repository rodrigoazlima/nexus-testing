import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { copyNexusDiagnostics, cleanupCreatedFiles } from '../helpers/vault-utils';
import { createStaleLogFixture } from '../helpers/nexus-state';

// cleanup-agent runs every 86400s (registry.yaml) — far past the suite's
// normal 10min test timeout, and there's no in-scope way to force-trigger it.
// Tagged @slow-agent (see package.json test:pipeline:fast/:slow); this test
// ties up a worker for ~24h, run it standalone/off-hours, not in a normal
// `npm test`.
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
      // own fixture doesn't linger — cleanupCreatedFiles ignores ENOENT, so
      // this is a no-op if the agent already purged it.
      await cleanupCreatedFiles([logPath]);
    });

    test('our backdated dummy log file is purged by the next cleanup cycle', async () => {
      test.setTimeout(25 * 60 * 60_000);

      logPath = await createStaleLogFixture();

      await expect(async () => {
        await expect(fs.access(logPath)).rejects.toThrow();
      }).toPass({ timeout: 24.5 * 60 * 60_000, intervals: [5 * 60_000] });
    });
  }
);
