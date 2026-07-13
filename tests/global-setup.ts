import {
  NEXUS_PATH,
  clearInstall,
  installFresh,
  warnIfEnvLocalMissing,
  withInstallLock,
} from './helpers/nexus-install';
import { marker, startSampler } from './helpers/profile';

// Fresh-installs Nexus before the suite runs: clear any dirty/leftover
// install, clone fresh, clean install. Mirrors custom-install.ps1's steps as
// our own TS copy, not a call into that script.
export default async function globalSetup(): Promise<void> {
  console.log(`[global-setup] target install: ${NEXUS_PATH}`);

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

  warnIfEnvLocalMissing();
  console.log('[global-setup] environment ready');
}
