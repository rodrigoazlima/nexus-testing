import { Page } from '@playwright/test';
import path from 'node:path';
import { copyFixtureWithRandomName, FIXTURES_DIR } from './vault-image-utils';
import { uploadViaButton, uploadViaDragAndDrop } from './dashboard-ui';
import { INBOX_IMAGES_DIR } from './config';

export interface UploadOptions {
  /**
   * Defaults to false: uploading a fixture that already entered the pipeline
   * this run throws (see guardAgainstDuplicateUpload in vault-image-utils.ts).
   * Set true only when re-uploading the same bytes IS the test
   * (image-duplication.spec.ts).
   */
  allowDuplicate?: boolean;
}

export interface StagedUpload {
  /** Staging copy the dashboard upload was fed from (outside the vault). */
  sourcePath: string;
  randomName: string;
}

// Dashboard uploads need the file on disk outside the vault first.
const TMP_SOURCE_DIR = path.join(FIXTURES_DIR, '.tmp');

/**
 * The one way to put a fixture image into the pipeline. All three entry
 * points route through copyFixtureWithRandomName, whose per-run ledger
 * rejects duplicate fixtures unless opts.allowDuplicate is set.
 */
export class ImageUpload {
  /** Filesystem drop straight into the vault inbox (or destDir). */
  static drop(
    fixtureName: string,
    destDir: string = INBOX_IMAGES_DIR,
    opts: UploadOptions = {}
  ): Promise<{ destPath: string; randomName: string }> {
    return copyFixtureWithRandomName(fixtureName, destDir, opts);
  }

  /** Stages the fixture, then uploads it via the /gm/inbox Upload button. */
  static async viaButton(page: Page, fixtureName: string, opts: UploadOptions = {}): Promise<StagedUpload> {
    const { destPath, randomName } = await copyFixtureWithRandomName(fixtureName, TMP_SOURCE_DIR, opts);
    await uploadViaButton(page, destPath);
    return { sourcePath: destPath, randomName };
  }

  /** Stages the fixture, then drag-and-drops it onto /gm/inbox. */
  static async viaDragAndDrop(page: Page, fixtureName: string, opts: UploadOptions = {}): Promise<StagedUpload> {
    const { destPath, randomName } = await copyFixtureWithRandomName(fixtureName, TMP_SOURCE_DIR, opts);
    await uploadViaDragAndDrop(page, destPath);
    return { sourcePath: destPath, randomName };
  }
}
