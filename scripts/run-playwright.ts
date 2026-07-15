import { spawnSync } from 'node:child_process';

// npm reserves bare flags (for example, `npm test --keep`) for its own
// configuration. Invoke this script through npm's argument separator instead:
// `npm test -- --keep`. Keep is consumed here so Playwright never sees an
// unsupported CLI option, while the lifecycle hooks receive an unambiguous
// environment flag.
//
// `--only` (npm run test:only -- <specs...>) runs just the named specs plus
// the required cleanup spec (stage-inbox-exclusion drains the shared
// created-paths registry — without it a filtered run leaves its files in the
// ledger). Global setup/teardown always run regardless of filters, so a
// --only run still gets a fresh install and a clean wipe. With --keep the
// cleanup spec is skipped too: keep means retain every artifact.
export function buildRun(args: string[]): { playwrightArgs: string[]; keep: boolean } {
  const keep = args.includes('--keep');
  const only = args.includes('--only');
  const playwrightArgs = args.filter((arg) => arg !== '--keep' && arg !== '--only');

  // ponytail: appended last but Playwright schedules files alphabetically
  // across parallel workers, so the drain can race a target spec's
  // registration — leftovers just sit in the ledger for the next drain,
  // same accepted risk as the full suite (see drainCreatedPathsRegistry).
  if (only && !keep) {
    playwrightArgs.push('tests/pipeline/stage-inbox-exclusion.spec.ts');
  }

  return { playwrightArgs, keep };
}

if (require.main === module) {
  const { playwrightArgs, keep } = buildRun(process.argv.slice(2));

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
}
