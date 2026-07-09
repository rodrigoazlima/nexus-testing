import fs from 'node:fs';
import { clearInstall, withInstallLock } from './helpers/nexus-install';
import { VAULT_PATH } from './helpers/config';

// Uninstalls the service and wipes NEXUS_PATH + VAULT_PATH after the suite
// finishes, leaving .testing clean for the next run. Same steps as
// scripts/clean.ts.
export default async function globalTeardown(): Promise<void> {
  withInstallLock('global-teardown', () => {
    clearInstall();

    if (fs.existsSync(VAULT_PATH)) {
      console.log(`[global-teardown] removing vault at ${VAULT_PATH}`);
      fs.rmSync(VAULT_PATH, { recursive: true, force: true });
    }
  });
}
