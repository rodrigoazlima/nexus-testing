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
} from './helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from './helpers/config';

const EXPECTED_TAGS = ['undead', 'skeleton'];

test.describe.serial('Bestiary classification: skeletor portrait -> creature/monster draft', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let notePath: string;
  let noteId: string;
  let enrichedData: FrontmatterData;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[bestiary-classification] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('skeletor image gets a fresh vision draft', async () => {
    const { randomName } = await test.step('drop skeletor image under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('skeletor.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath: freshNotePath, imagePath, data: visionData } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(freshNotePath, imagePath);
    notePath = freshNotePath;
    noteId = path.basename(notePath, '.md');

    await test.step('assert frontmatter invariants on the fresh vision draft', () => {
      assertDraftInvariants(visionData, noteId);
    });
  });

  // ponytail: 3min ceiling (shortened from 20min per 2026-07-09 perf
  // review, alongside the 10min POLL_TIMEOUT_MS/TEST_TIMEOUT_MS shrink) —
  // this agent is due immediately after a clean install same as vision,
  // and a tight budget fails fast (LocalRouter down, prompt drift) instead
  // of silently eating the rest of the 10min test timeout.
  test('skeletor image gets classified with a bestiary type', async () => {
    const { data } = await test.step(
      'wait for the classification agent to enrich tags and infer a bestiary type',
      () =>
        pollNoteUntil(
          notePath,
          (d) =>
            (BESTIARY_TYPES as readonly string[]).includes(d.type) &&
            EXPECTED_TAGS.every((tag) => d.tags.includes(tag)),
          (d) =>
            `Still waiting for classification. type="${d?.type}" tags=[${(d?.tags ?? []).join(', ')}] ` +
            `— want type in [${BESTIARY_TYPES.join(', ')}] and tags including [${EXPECTED_TAGS.join(', ')}].`,
          { timeout: 3 * 60_000 }
        )
    );
    enrichedData = data;

    await test.step('assert enriched type', () => {
      console.log(
        `[bestiary-classification] expected type in [${BESTIARY_TYPES.join(', ')}], actual: "${enrichedData.type}"`
      );
      expect(
        BESTIARY_TYPES as readonly string[],
        `type — expected one of: [${BESTIARY_TYPES.join(', ')}], actual: "${enrichedData.type}"`
      ).toContain(enrichedData.type);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`skeletor.jpg (enriched) tags include "${tag}"`, () => {
      expect(
        enrichedData.tags,
        `tags — expected to include "${tag}", actual: [${(enrichedData.tags ?? []).join(', ')}]`
      ).toContain(tag);
    });
  }

  test('skeletor entity shows up on the dashboard bestiary page', async ({ page }) => {
    await page.goto('/gm/bestiary');
    await expect(page.getByText(noteId, { exact: true }).first()).toBeVisible();
  });
});
