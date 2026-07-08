import { defineConfig, devices } from '@playwright/test';

// Tests wait for the real vault-knowledge-factory daemon (60s runtime loop,
// 900s vision-agent interval) — there is no in-scope way to force-trigger it,
// so the per-test timeout must comfortably exceed one full vision cycle.
// A live run (2026-07-07) showed the daemon working through a large real
// RAW/ backlog first — three ~17min batches ran before it reached a freshly
// dropped file, so 25min wasn't enough. Budget generously.
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 90 * 60_000);

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
  // Tests share one real vault (no fixtures/teardown isolation between runs),
  // so they must not run concurrently against the same inbox/processing folders.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
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
