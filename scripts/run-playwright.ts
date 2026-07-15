import { spawnSync } from 'node:child_process';

// npm reserves bare flags (for example, `npm test --keep`) for its own
// configuration. Invoke this script through npm's argument separator instead:
// `npm test -- --keep`. Keep is consumed here so Playwright never sees an
// unsupported CLI option, while the lifecycle hooks receive an unambiguous
// environment flag.
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const playwrightArgs = args.filter((arg) => arg !== '--keep');

const result = spawnSync(
  process.execPath,
  [require.resolve('@playwright/test/cli'), 'test', ...playwrightArgs],
  {
    env: {
      ...process.env,
      ...(keep ? { NEXUS_TEST_KEEP: '1' } : {}),
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
