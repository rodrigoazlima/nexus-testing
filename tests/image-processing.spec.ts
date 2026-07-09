import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  hasSection,
  cleanupCreatedFiles,
} from './helpers/vault-utils';
import { openNoteByUuid, assertNoteMatchesFrontmatter } from './helpers/dashboard-ui';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from './helpers/config';

test.describe.serial('Image ingestion pipeline: 00-Inbox/images -> 01-Processing draft', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;

  test.beforeAll(async () => {
    // The vault already holds ~150 inbox images and ~260 processing drafts
    // from real use — "clean state" here means "recorded baseline to diff
    // against," not "empty folder."
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterAll(async () => {
    // Never delete folders on this OneDrive-backed vault (Cloud-Files
    // placeholder risk) — only the specific files this run created.
    await cleanupCreatedFiles(createdPaths);
  });

  test('renames dropped sword image and produces an enriched draft note', async ({ page }) => {
    const { randomName } = await test.step('drop sword image under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('sword-test.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    // No in-scope way to force-trigger the vision agent — that lives in
    // C:\Users\rodrigo\nexus, out of bounds for this suite. Wait out the
    // real daemon instead: a 60s runtime loop feeding a 900s vision-agent
    // interval, same as a human dropping a file would experience.
    const { notePath, imagePath, data, content } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);

    await test.step('assert frontmatter invariants', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
    });

    await test.step('assert source references the renamed image (no ![[embed]] in this pipeline)', () => {
      expect(data.source.some((src) => src.endsWith(path.basename(imagePath)))).toBe(true);
      expect(content).not.toMatch(/!\[\[.*\]\]/);
    });

    await test.step('assert body has the expected sections', () => {
      expect(hasSection(content, 'Description')).toBe(true);
      expect(hasSection(content, 'Related')).toBe(true);
    });

    await test.step('assert the dashboard reflects the same note', async () => {
      await openNoteByUuid(page, data.uuid);
      await assertNoteMatchesFrontmatter(page, data, imagePath);
    });
  });
});
