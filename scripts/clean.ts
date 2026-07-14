import 'dotenv/config';
import fs from 'node:fs';
import { NEXUS_PATH, clearInstall, withInstallLock } from '../tests/helpers/nexus-install';
import { VAULT_PATH } from '../tests/helpers/config';

withInstallLock('clean', () => {
  clearInstall();

  if (fs.existsSync(VAULT_PATH)) {
    console.log(`removing vault at ${VAULT_PATH}`);
    fs.rmSync(VAULT_PATH, { recursive: true, force: true });
  }
});

console.log(`clean: ${NEXUS_PATH} and ${VAULT_PATH} removed`);
