import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  assertTagsInclude,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { openNoteByUuid, assertNoteMatchesFrontmatter } from '../helpers/dashboard-ui';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { promoteToLibrary } from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/bobby-barbarian.spec.ts). Correct
// from observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'barbarian'];

// No active agent promotes 01-Processing -> 02-Library or sets
// status: approved (curator-agent, which would, has no agent.json yet —
// spec-only). This test simulates the human review step directly, the same
// way a DM would: write the approved frontmatter and move the file.
test.describe.serial('02-Library stage: human promotion sets status: approved', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[stage-library-promotion] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('promoted note shows approved status and Library location in the dashboard', async ({
    page,
  }) => {
    const { randomName } = await test.step('drop bobby-barbarian image under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('bobby-barbarian.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath, imagePath, data } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);

    await test.step('assert frontmatter invariants on the fresh draft', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
    });

    await test.step('assert tags', () => {
      assertTagsInclude(data.tags, EXPECTED_TAGS, 'bobby-barbarian.jpg');
    });

    const { libraryNotePath, data: promotedData } = await test.step(
      'simulate human review: approve + promote into 02-Library',
      () => promoteToLibrary(notePath)
    );
    createdPaths.push(libraryNotePath);

    await test.step('assert promoted frontmatter invariants', () => {
      console.log(
        `[stage-library-promotion] promoted actual={status:"${promotedData.status}", quality:${promotedData.quality}, ` +
          `reviewed:${promotedData.reviewed}, relationships.length:${promotedData.relationships.length}}`
      );
      expect(promotedData.status, `status — expected: "approved", actual: "${promotedData.status}"`).toBe(
        'approved'
      );
      expect(
        promotedData.quality,
        `quality — expected: >= 7, actual: ${promotedData.quality}`
      ).toBeGreaterThanOrEqual(7);
      expect(promotedData.reviewed, `reviewed — expected: true, actual: ${promotedData.reviewed}`).toBe(true);
      expect(
        promotedData.relationships.length,
        `relationships.length — expected: > 0, actual: ${promotedData.relationships.length}`
      ).toBeGreaterThan(0);
    });

    await test.step('assert the dashboard reflects the approved, promoted note', async () => {
      await openNoteByUuid(page, promotedData.uuid);
      await assertNoteMatchesFrontmatter(page, promotedData, imagePath);
    });
  });
});
