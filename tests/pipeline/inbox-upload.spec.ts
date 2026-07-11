import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { copyFixtureWithRandomName, registerCreatedPaths } from '../helpers/vault-utils';
import { uploadViaButton, uploadViaDragAndDrop } from '../helpers/dashboard-ui';
import { INBOX_IMAGES_DIR } from '../helpers/config';

// Scoped fast: only proves the upload entry point lands the file and the
// dashboard reflects it. Does NOT wait for the vision daemon to turn it into
// a draft note — /gm/inbox showed 735 images queued / 590 stuck >24h
// (2026-07-07), so a full round-trip per entry point would cost up to 90min
// each. image-processing.spec.ts already proves the full pipeline once via
// a plain filesystem drop.
const TMP_SOURCE_DIR = path.join(__dirname, 'fixtures', 'test-images', '.tmp');

test.describe.serial('Inbox upload entry points (dashboard UI)', () => {
  const createdPaths: string[] = [];

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('uploads sword image via the /gm/inbox Upload button', async ({ page }) => {
    const { destPath: sourcePath, randomName } = await copyFixtureWithRandomName(
      'sword-test.jpg',
      TMP_SOURCE_DIR
    );
    createdPaths.push(sourcePath);

    await uploadViaButton(page, sourcePath);

    const landedPath = path.join(INBOX_IMAGES_DIR, randomName);
    await expect(async () => {
      await fs.access(landedPath);
    }, `landedPath — expected: "${landedPath}" to exist on disk after upload`).toPass({
      timeout: 30_000,
      intervals: [1_000],
    });
    createdPaths.push(landedPath);

    await page.goto('/gm/inbox');
    await expect(
      page.getByText(randomName, { exact: true }),
      `/gm/inbox — expected: "${randomName}" visible in the file list`
    ).toBeVisible();
  });

  test('uploads sword image via drag-and-drop onto /gm/inbox', async ({ page }) => {
    const { destPath: sourcePath, randomName } = await copyFixtureWithRandomName(
      'sword-test.jpg',
      TMP_SOURCE_DIR
    );
    createdPaths.push(sourcePath);

    await uploadViaDragAndDrop(page, sourcePath);

    const landedPath = path.join(INBOX_IMAGES_DIR, randomName);
    await expect(async () => {
      await fs.access(landedPath);
    }, `landedPath — expected: "${landedPath}" to exist on disk after upload`).toPass({
      timeout: 30_000,
      intervals: [1_000],
    });
    createdPaths.push(landedPath);

    await page.goto('/gm/inbox');
    await expect(
      page.getByText(randomName, { exact: true }),
      `/gm/inbox — expected: "${randomName}" visible in the file list`
    ).toBeVisible();
  });
});
