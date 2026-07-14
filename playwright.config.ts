import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

// Shortened to 10min (from 90min) per 2026-07-09 perf review: the 2026-07-09
// live run burned the full 89min budget and still failed on an empty queue
// (no backlog excuse), suspected cause is .env.local getting wiped by
// -CleanInstall. A short ceiling fails fast so that's cheap to confirm.
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 10 * 60_000);

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: require.resolve('./tests/global-setup'),
  globalTeardown: require.resolve('./tests/global-teardown'),
  timeout: TEST_TIMEOUT_MS,
  // NOT TEST_TIMEOUT_MS: this is the default for every individual
  // expect(...) call. Only waitForSlugNote's own .toPass() needs the long
  // budget, and it already gets it via an explicit per-call `timeout` option
  // (see helpers/vault-utils.ts). Leaving this at 90min meant an ordinary
  // failing UI assertion (e.g. a bad selector) would silently retry for 90
  // minutes instead of failing in seconds — confirmed live: a completed
  // draft note sat ready for 15+ minutes while the test kept polling.
  expect: {
    timeout: 15_000,
  },
  // Tests share one real vault (no fixtures/teardown isolation between runs).
  // Running spec FILES concurrently is a deliberate accepted risk (baseline
  // diffing in waitForSlugNote can cross-match another test's renamed file if
  // two specs race close together) — keep fullyParallel:false so tests
  // *within* a file still run in written order (matches describe.serial).
  fullyParallel: false,
  workers: 3,
  retries: 0,
  // profile-reporter only writes per-test phase markers for the resource
  // usage report (tests/helpers/profile.ts) — the html report itself gets a
  // resource-usage.html copy dropped in by global-teardown's buildReport().
  reporter: [['list'], ['html', { open: 'never' }], ['./scripts/profile-reporter.ts']],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:48080',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
