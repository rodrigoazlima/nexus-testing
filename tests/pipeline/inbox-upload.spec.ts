import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { registerCreatedPaths } from '../helpers/vault-utils';
import { ImageUpload } from '../helpers/image-upload';
import { INBOX_IMAGES_DIR } from '../helpers/config';

// Scoped fast: only proves the upload entry point lands the file and the
// dashboard reflects it. Does NOT wait for the vision daemon to turn it into
// a draft note — /gm/inbox showed 735 images queued / 590 stuck >24h
// (2026-07-07), so a full round-trip per entry point would cost up to 90min
// each. image-processing.spec.ts already proves the full pipeline once via
// a plain filesystem drop.
//
// Distinct fixture per entry point (sword-test button, axe2 drag-and-drop):
// the duplicate-upload guard in copyFixtureWithRandomName rejects a second
// upload of the same fixture per run by design.

test.describe.serial('Inbox upload entry points (dashboard UI)', () => {
  const createdPaths: string[] = [];

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('uploads sword image via the /gm/inbox Upload button', async ({ page }) => {
    const { sourcePath, randomName } = await ImageUpload.viaButton(page, 'sword-test.jpg');
    createdPaths.push(sourcePath);

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

  test('uploads axe image via drag-and-drop onto /gm/inbox', async ({ page }) => {
    const { sourcePath, randomName } = await ImageUpload.viaDragAndDrop(page, 'axe2.webp');
    createdPaths.push(sourcePath);

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
