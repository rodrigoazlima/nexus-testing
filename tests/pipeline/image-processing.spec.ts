import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  hasSection,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { openNoteByUuid, assertNoteMatchesFrontmatter } from '../helpers/dashboard-ui';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

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

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[image-processing] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
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
      const imageBasename = path.basename(imagePath);
      const sourceMatches = data.source.some((src) => src.endsWith(imageBasename));
      console.log(
        `[image-processing] source — expected: an entry ending with "${imageBasename}", actual: ${JSON.stringify(data.source)}`
      );
      expect(
        sourceMatches,
        `source — expected: an entry ending with "${imageBasename}", actual: ${JSON.stringify(data.source)}`
      ).toBe(true);
      expect(
        content,
        `content — expected: no "![[embed]]" syntax, actual content contains one`
      ).not.toMatch(/!\[\[.*\]\]/);
    });

    await test.step('assert body has the expected sections', () => {
      const hasDescription = hasSection(content, 'Description');
      const hasRelated = hasSection(content, 'Related');
      console.log(
        `[image-processing] sections — expected: Description=true, Related=true | actual: Description=${hasDescription}, Related=${hasRelated}`
      );
      expect(hasDescription, `## Description section — expected: true, actual: ${hasDescription}`).toBe(true);
      expect(hasRelated, `## Related section — expected: true, actual: ${hasRelated}`).toBe(true);
    });

    await test.step('assert the dashboard reflects the same note', async () => {
      await openNoteByUuid(page, data.uuid);
      await assertNoteMatchesFrontmatter(page, data, imagePath);
    });
  });
});
