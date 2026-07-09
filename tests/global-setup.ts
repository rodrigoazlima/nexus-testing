import { NEXUS_PATH, clearInstall, installFresh, withInstallLock } from './helpers/nexus-install';

// Fresh-installs Nexus before the suite runs: clear any dirty/leftover
// install, clone fresh, clean install. Mirrors custom-install.ps1's steps as
// our own TS copy, not a call into that script.
export default async function globalSetup(): Promise<void> {
  console.log(`[global-setup] target install: ${NEXUS_PATH}`);
  withInstallLock('global-setup', () => {
    clearInstall();
    installFresh();
  });
  console.log('[global-setup] environment ready');
}
