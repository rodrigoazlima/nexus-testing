import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { marker } from '../tests/helpers/profile';

// Emits one start/end marker pair per test so the resource-usage report
// (tests/helpers/profile.ts) can slice system samples per test. The sampler
// itself is started/stopped by global-setup/global-teardown, so the capture
// also covers install and uninstall — phases reporters never see.
class ProfileReporter implements Reporter {
  printsToStdio(): boolean {
    return false;
  }
  onTestBegin(test: TestCase): void {
    marker(`test:${test.title}`, 'start');
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    marker(`test:${test.title}`, 'end', result.status);
  }
}

export default ProfileReporter;
