import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  snapshotDir,
  waitForSlugNote,
  assertDraftInvariants,
  assertTagsInclude,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { INBOX_QUEUE_PATH, readJsonState, findEntryByFilename } from '../helpers/nexus-state';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'test-images', 'axe.jpg');

// Verified 2026-07-15 by calling classify_images._classify_one() directly on
// axe.jpg (bypassing this harness — the original "live daemon run" that
// produced this same value was actually a cross-matched note from a
// concurrent spec, see feedback/tips_to_fix.md issue #1; the value happened
// to be right but the method wasn't). 4/4 direct-classification runs agreed.
// VisionClassification (system/src/nexus/shared/models.py) has no item/weapon
// vocabulary — ImageType is portrait/body/battlemap/scene only (LLM-chosen;
// "token" is only ever forced post-hoc for transparent-corner PNGs, which a
// .jpg can never be). A standalone object on a plain background falls into
// "scene" per the classifier prompt's own definition ("objects" is listed
// under scene), with "interior" as the environment guess. Do not change this
// back to axe/weapon-flavored tags without re-verifying via direct classification.
const EXPECTED_TAGS = ['scene', 'interior'];

interface QueueEntry {
  agents: Record<string, string>;
}

test.describe.serial('Ingestion stage: messy filename -> normalized + queued for the right agents', () => {
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
      console.log(`[stage-inbox-ingestion] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('messy-named drop is normalized by ingestion and queued image-type-only for vision/lore/classification', async () => {
    // Deliberately messy name (spaces + emoji) — ingestion's job is to strip
    // this before vision ever sees the file (agents/ingestion/AGENT.md).
    const messyName = `IMG \u{1F5E1}️ ${Date.now()} test.jpg`;

    await test.step('drop image under a messy filename', async () => {
      await fs.mkdir(INBOX_IMAGES_DIR, { recursive: true });
      const destPath = path.join(INBOX_IMAGES_DIR, messyName);
      await fs.copyFile(FIXTURE_PATH, destPath);
      createdPaths.push(destPath);
    });

    const { notePath, imagePath, data } = await test.step(
      'wait for ingestion to normalize + queue the file, and vision to rename it again into a draft',
      () => waitForSlugNote(messyName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);

    await test.step('assert frontmatter invariants', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
    });

    await test.step('assert tags', () => {
      assertTagsInclude(data.tags, EXPECTED_TAGS, 'axe.jpg (messy filename)');
    });

    await test.step('assert inbox-queue.json registered this image with the right agent slots', async () => {
      const queue = await readJsonState<unknown>(INBOX_QUEUE_PATH);
      const entry = findEntryByFilename<QueueEntry>(queue, path.basename(imagePath));
      expect(entry, `no inbox-queue.json entry found referencing ${path.basename(imagePath)}`).toBeTruthy();
      console.log(
        `[stage-inbox-ingestion] agents actual={wiki:"${entry!.agents.wiki}", vision:"${entry!.agents.vision}"}`
      );
      expect(
        entry!.agents.wiki,
        `agents.wiki — expected: "skip" (image-type files never queued for wiki), actual: "${entry!.agents.wiki}"`
      ).toBe('skip');
      expect(
        entry!.agents.vision,
        `agents.vision — expected: "done", actual: "${entry!.agents.vision}"`
      ).toBe('done');
    });
  });
});
