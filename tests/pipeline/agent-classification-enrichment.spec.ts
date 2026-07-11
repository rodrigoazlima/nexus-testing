import { test } from '@playwright/test';
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
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import {
  PROCESSED_IMAGES_PATH,
  pollJsonState,
  findEntryByFilename,
} from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (see tests/image-tags/elf-warrior.spec.ts). Correct from observed output
// after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'elf', 'warrior'];

interface ProcessedImageEntry {
  status: string;
}

test.describe.serial('classification-agent: tag/type enrichment + processed-images status', () => {
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
      console.log(`[agent-classification-enrichment] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('elf-warrior image gets full tags and an ok processed-images.json entry', async () => {
    const { randomName } = await test.step('drop elf-warrior.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('elf-warrior.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath, imagePath, data } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);

    await test.step('assert frontmatter invariants', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
    });

    await test.step('assert tags', () => {
      assertTagsInclude(data.tags, EXPECTED_TAGS, 'elf-warrior.jpg');
    });

    await test.step('assert classification-agent recorded an ok processed-images.json entry', async () => {
      const finalName = path.basename(imagePath);
      await pollJsonState<unknown>(
        PROCESSED_IMAGES_PATH,
        (state) => findEntryByFilename<ProcessedImageEntry>(state, finalName)?.status === 'ok',
        (state) =>
          `Still waiting for a processed-images.json entry with status "ok" for ${finalName}. ` +
          `Found: ${JSON.stringify(findEntryByFilename<ProcessedImageEntry>(state, finalName))}`,
        { timeout: 3 * 60_000 }
      );
    });
  });
});
