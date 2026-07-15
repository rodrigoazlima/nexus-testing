import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  registerCreatedPaths,
  drainCreatedPathsRegistry,
  copyForInspection,
  copyNexusDiagnostics,
  type FrontmatterData,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

// Moved + refactored from the deleted tests/image-tags/power-sword.spec.ts.
// Per-file afterAll(cleanupCreatedFiles(...)) was centralized here: every
// other spec now hands its created paths to registerCreatedPaths instead of
// deleting them itself (see vault-utils.ts). This test is the "exclusion"
// stage — the only place in the suite that actually deletes anything — so
// "created test artifacts get deleted" is itself a tested pipeline stage
// (positioned right after stage-inbox-ingestion.spec.ts), not silent
// per-file teardown.
//
// ponytail: tags beyond [0] (the category) are guessed from the filename,
// not verified against real vision-agent output — GRAPH_REPORT.md carries
// no per-image tag ground truth for this fixture. Correct from observed
// output after the first real run against the live daemon.
const EXPECTED_TAGS = ['token', 'sword', 'weapon'];

test.describe.serial('Exclusion stage: the shared cleanup registry actually deletes what other specs hand it', () => {
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
      console.log(`[stage-inbox-exclusion] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test('Power_Sword.webp drop registers cleanly with valid frontmatter', async () => {
    const { randomName } = await test.step('drop Power_Sword.webp under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('Power_Sword.webp');
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
    test(`Power_Sword.webp tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }

  test('draining the registry deletes this run\'s files', async () => {
    await test.step("hand this run's files to the shared exclusion registry", () =>
      registerCreatedPaths(createdPaths)
    );

    const attemptedPaths = await test.step(
      "drain the registry — every registered path (this test's + any other spec's leftovers) gets deleted",
      () => drainCreatedPathsRegistry()
    );
    console.log(
      `[stage-inbox-exclusion] drain — expected: attempted paths superset of this test's own ${JSON.stringify(createdPaths)} | ` +
        `actual attempted (${attemptedPaths.length} total): ${JSON.stringify(attemptedPaths)}`
    );
    for (const p of createdPaths) {
      expect(
        attemptedPaths,
        `expected the drain to have attempted this test's own "${p}", actual attempted set: ${JSON.stringify(attemptedPaths)}`
      ).toContain(p);
    }

    await test.step("assert this run's own files are actually gone from disk", async () => {
      for (const p of createdPaths) {
        let stillExists = true;
        try {
          await fs.access(p);
        } catch {
          stillExists = false;
        }
        console.log(`[stage-inbox-exclusion] "${p}" — expected: deleted (access fails), actual stillExists: ${stillExists}`);
        expect(stillExists, `expected "${p}" to be deleted by the drain, actual: still exists on disk`).toBe(false);
      }
    });
  });
});
