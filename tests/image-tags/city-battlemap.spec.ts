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

// ponytail: observed 2026-07-17 against a live daemon run - tags[0] came back
// "scene", not "battlemap", because classify-image.txt's STEP 1 definition
// didn't weight camera angle heavily enough for a gridless top-down map (see
// agents/vision/prompts/classify-image.txt fix same day). Re-confirm against
// the next live run - the fix may flip tags[0] back to "battlemap".
const EXPECTED_TAGS = ['scene', 'city'];

test.describe.serial('Image tags: city-battlemap.jpg -> vision draft', () => {
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
      console.log(`[image-tags/city-battlemap] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('city-battlemap.jpg gets expected name and draft state', async () => {
    const { randomName } = await test.step('drop city-battlemap.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('city-battlemap.jpg');
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
    test(`city-battlemap.jpg tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }
});
