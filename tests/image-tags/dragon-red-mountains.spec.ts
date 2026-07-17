import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  pollNoteUntil,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
  BESTIARY_TYPES,
  type FrontmatterData,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

// ponytail: tags beyond [0] (the category) are guessed from the filename, not
// verified against real vision-agent output — GRAPH_REPORT.md carries no
// per-image tag ground truth for this fixture (only skeletor.jpg has one, via
// bestiary-classification.spec.ts). Correct from observed output after the
// first real run against the live daemon.
const EXPECTED_TAGS = ['dragon', 'red', 'mountains'];

test.describe.serial('Image tags: dragon-red-mountains.jpg -> vision draft', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let data: FrontmatterData;
  let notePath: string;
  let noteId: string;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[image-tags/dragon-red-mountains] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('dragon-red-mountains.jpg gets expected name and draft state', async () => {
    const { randomName } = await test.step('drop dragon-red-mountains.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('dragon-red-mountains.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath: freshNotePath, imagePath, data: freshData } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(freshNotePath, imagePath);
    notePath = freshNotePath;
    data = freshData;
    noteId = path.basename(notePath, '.md');

    await test.step('validate name', () => {
      expect(data.id, `id — expected: "${noteId}" (note filename stem), actual: "${data.id}"`).toBe(noteId);
    });

    await test.step('validate current state', () => {
      assertDraftInvariants(data, noteId);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`dragon-red-mountains.jpg tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }

  // ponytail: 3min ceiling matches bestiary-classification.spec.ts — this
  // agent is due immediately after vision, so a tight budget fails fast.
  test('dragon-red-mountains.jpg gets classified into the bestiary and shows on the dashboard', async ({
    page,
  }) => {
    const { data: enrichedData } = await test.step(
      'wait for the classification agent to place dragon-red-mountains.jpg in the bestiary',
      () =>
        pollNoteUntil(
          notePath,
          (d) => (BESTIARY_TYPES as readonly string[]).includes(d.type),
          (d) =>
            `Still waiting for classification. type="${d?.type}" ` +
            `— want type in [${BESTIARY_TYPES.join(', ')}].`,
          { timeout: 3 * 60_000 }
        )
    );

    await test.step('assert bestiary type', () => {
      expect(
        BESTIARY_TYPES as readonly string[],
        `type — expected one of: [${BESTIARY_TYPES.join(', ')}], actual: "${enrichedData.type}"`
      ).toContain(enrichedData.type);
    });

    await test.step('assert dragon-red-mountains.jpg shows up on the dashboard bestiary page', async () => {
      await page.goto('/gm/bestiary');
      await expect(page.getByText(noteId, { exact: true }).first()).toBeVisible();
    });
  });
});
