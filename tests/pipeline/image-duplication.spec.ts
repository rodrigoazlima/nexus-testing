import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { ImageUpload } from '../helpers/image-upload';
import { INBOX_IMAGES_DIR } from '../helpers/config';

// Deliberately uploads the SAME fixture twice ({ allowDuplicate: true }
// bypasses the suite's own per-run upload guard) to pin the SYSTEM's dedupe
// behavior: the second copy must be ignored and the dashboard must warn
// "Image already uploaded".
//
// Scoped fast like inbox-upload.spec.ts: the first upload only needs to LAND
// (no vision-cycle wait) — the expected dedupe happens at upload time,
// against the received bytes, not against a processed note.
//
// ponytail: the warning-text and ignored-copy assertions encode expected
// behavior, not yet confirmed against a live daemon run — if the dashboard
// lacks upload-time dedupe, this spec fails and that's the finding (hard
// rule: never fake what can't be verified live).
//
// master.jpg — previously unused fixture, reserved for this spec so the
// duplicate pair stays isolated from every other spec's uploads.
const FIXTURE = 'master.jpg';

test.describe.serial('Duplicate image upload: system ignores the copy and warns', () => {
  const createdPaths: string[] = [];

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[image-duplication] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test(`first ${FIXTURE} upload lands in the inbox`, async ({ page }) => {
    const { sourcePath, randomName } = await ImageUpload.viaButton(page, FIXTURE);
    createdPaths.push(sourcePath);

    const landedPath = path.join(INBOX_IMAGES_DIR, randomName);
    await expect(async () => {
      await fs.access(landedPath);
    }, `landedPath — expected: "${landedPath}" to exist on disk after upload`).toPass({
      timeout: 30_000,
      intervals: [1_000],
    });
    createdPaths.push(landedPath);
  });

  test(`re-uploading ${FIXTURE} is ignored and warns "Image already uploaded"`, async ({ page }) => {
    const { sourcePath, randomName } = await ImageUpload.viaButton(page, FIXTURE, {
      allowDuplicate: true,
    });
    createdPaths.push(sourcePath);

    await expect(
      page.getByText('Image already uploaded', { exact: false }),
      'dashboard — expected: an "Image already uploaded" warning after re-uploading identical bytes'
    ).toBeVisible({ timeout: 30_000 });

    // "Ignored" = the duplicate never lands next to the original. Checked
    // after the warning is visible, so the system has finished handling the
    // upload by the time we look.
    const landedPath = path.join(INBOX_IMAGES_DIR, randomName);
    let stillLanded = true;
    try {
      await fs.access(landedPath);
    } catch {
      stillLanded = false;
    }
    console.log(
      `[image-duplication] "${landedPath}" — expected: never lands (duplicate ignored), actual landed: ${stillLanded}`
    );
    expect(stillLanded, `expected the duplicate "${randomName}" to be ignored, actual: it landed in the inbox`).toBe(
      false
    );
    // Registered anyway: if the system DID land it (test failure), the
    // exclusion drain still cleans it up — cleanup tolerates ENOENT.
    createdPaths.push(landedPath);
  });
});
