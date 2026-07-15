import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
  type FrontmatterData,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

// tags[0] confirmed against real vision-agent output (2026-07-14 run):
// full-body standing figure -> "body", not "portrait". Rest of tags beyond
// [0] still filename-guessed — GRAPH_REPORT.md carries no per-image tag
// ground truth for this fixture (only skeletor.jpg has one, via
// bestiary-classification.spec.ts).
const EXPECTED_TAGS = ['body', 'elf', 'ranger'];

test.describe.serial('Image tags: elf-ranger.jpg -> vision draft', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let data: FrontmatterData;

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
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('elf-ranger.jpg gets expected name and draft state', async () => {
    const { randomName } = await test.step('drop elf-ranger.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('elf-ranger.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath, imagePath, data: freshData } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);
    data = freshData;
    const noteId = path.basename(notePath, '.md');

    await test.step('validate name', () => {
      expect(data.id, `id — expected: "${noteId}" (note filename stem), actual: "${data.id}"`).toBe(noteId);
    });

    await test.step('validate current state', () => {
      assertDraftInvariants(data, noteId);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`elf-ranger.jpg tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }
});
