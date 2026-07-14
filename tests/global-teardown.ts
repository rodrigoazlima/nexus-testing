import fs from 'node:fs';
import { clearInstall, withInstallLock } from './helpers/nexus-install';
import { VAULT_PATH } from './helpers/config';
import { buildReport, marker, stopSampler } from './helpers/profile';

// Uninstalls the service and wipes NEXUS_PATH + VAULT_PATH after the suite
// finishes, leaving .testing clean for the next run. Same steps as
// scripts/clean.ts. `npm test --keep` (npm_config_keep) skips this so the
// install/vault can be inspected post-run.
export default async function globalTeardown(): Promise<void> {
  marker('uninstall', 'start');

  if (process.env.npm_config_keep) {
    console.log('[global-teardown] --keep set, leaving NEXUS_PATH and VAULT_PATH in place');
  } else {
    withInstallLock('global-teardown', () => {
      clearInstall();

      if (fs.existsSync(VAULT_PATH)) {
        console.log(`[global-teardown] removing vault at ${VAULT_PATH}`);
        fs.rmSync(VAULT_PATH, { recursive: true, force: true });
      }
    });
  }
  marker('uninstall', 'end');

  stopSampler();
  buildReport();
}
