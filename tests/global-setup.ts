import fs from 'node:fs';
import {
  NEXUS_PATH,
  assertSandboxRuntimeAvailable,
  assertVisionModelAvailable,
  clearInstall,
  installFresh,
  warnIfEnvLocalMissing,
  withInstallLock,
} from './helpers/nexus-install';
import { uploadedFixturesLedgerPath } from './helpers/vault-image-utils';
import { marker, startSampler } from './helpers/profile';

// Fresh-installs Nexus before the suite runs: clear any dirty/leftover
// install, clone fresh, clean install. Mirrors custom-install.ps1's steps as
// our own TS copy, not a call into that script.
export default async function globalSetup(): Promise<void> {
  console.log(`[global-setup] target install: ${NEXUS_PATH}`);
  // Fail fast, before burning any time on clone/install: a dead sandbox
  // runtime or a dead Qwen3-VL server otherwise surfaces 10min later as
  // every vision-dependent spec timing out, one at a time.
  await assertSandboxRuntimeAvailable();
  await assertVisionModelAvailable();
  if (process.env.NEXUS_TEST_KEEP) {
    console.log('[global-setup] --keep set, global-teardown will leave NEXUS_PATH and VAULT_PATH in place');
  }

  // Resource capture spans the whole lifecycle (baseline → install → tests →
  // uninstall); the sampler is stopped by global-teardown. The short pause
  // buys a couple of pre-install baseline samples.
  startSampler();
  marker('baseline', 'start');
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  marker('baseline', 'end');

  marker('install', 'start');
  withInstallLock('global-setup', () => {
    clearInstall();
    installFresh();
  });
  marker('install', 'end');

  // The duplicate-upload guard's ledger scopes to one run — stale entries
  // from a previous run would false-positive every spec's first upload.
  fs.rmSync(uploadedFixturesLedgerPath(), { force: true });

  warnIfEnvLocalMissing();
  console.log('[global-setup] environment ready');
}
