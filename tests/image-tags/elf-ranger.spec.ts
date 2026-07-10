import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  copyForInspection,
  copyNexusDiagnostics,
  cleanupCreatedFiles,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

// ponytail: tags beyond [0] (the category) are guessed from the filename, not
// verified against real vision-agent output — GRAPH_REPORT.md carries no
// per-image tag ground truth for this fixture (only skeletor.jpg has one, via
// bestiary-classification.spec.ts). Correct from observed output after the
// first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'elf', 'ranger'];

test.describe.serial('Image tags: elf-ranger.jpg -> vision draft', () => {
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
      console.log(`[image-tags/elf-ranger] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Never delete folders on this OneDrive-backed vault (Cloud-Files
    // placeholder risk) — only the specific files this run created.
    await cleanupCreatedFiles(createdPaths);
  });

  test('elf-ranger.jpg gets expected tags, name, and draft state', async () => {
    const { randomName } = await test.step('drop elf-ranger.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('elf-ranger.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath, imagePath, data } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);
    const noteId = path.basename(notePath, '.md');

    await test.step('validate name', () => {
      expect(data.id, 'frontmatter id must equal the note filename stem').toBe(noteId);
    });

    await test.step('validate current state', () => {
      assertDraftInvariants(data, noteId);
    });

    await test.step('validate tags', () => {
      for (const tag of EXPECTED_TAGS) {
        expect(data.tags, `tags must include "${tag}"`).toContain(tag);
      }
    });
  });
});
