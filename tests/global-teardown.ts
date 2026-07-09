import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { NEXUS_PATH, SETUP_SCRIPT, withInstallLock } from './helpers/nexus-install';

// Uninstalls the Nexus service after the suite finishes, leaving the machine
// clean for the next run.
export default async function globalTeardown(): Promise<void> {
  withInstallLock('global-teardown', () => {
    if (fs.existsSync(SETUP_SCRIPT)) {
      console.log('[global-teardown] uninstalling service');
      execFileSync('pwsh', ['-File', SETUP_SCRIPT, '-Uninstall'], { stdio: 'inherit' });
    } else {
      console.log(`[global-teardown] no service found at ${NEXUS_PATH}, nothing to uninstall`);
    }
  });
}
