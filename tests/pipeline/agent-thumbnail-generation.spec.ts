import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
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
import { THUMBS_DIR, computeSha1 } from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/florest-cave.spec.ts). Correct
// from observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['scene', 'cave', 'forest'];

// thumbnails-agent runs every 3600s (registry.yaml) — well past the suite's
// normal 10min test timeout, and there's no in-scope way to force-trigger it.
// Tagged @slow-agent (see package.json test:pipeline:fast/:slow) with its own
// ~70min budget instead of being skipped.
test.describe.serial(
  'thumbnails-agent: dropped image gets a 320px webp thumbnail',
  { tag: '@slow-agent' },
  () => {
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
        console.log(`[agent-thumbnail-generation] FAILED — files copied for inspection to ${dir}`);
      }
    });

    test.afterAll(async () => {
      // Never delete folders on this OneDrive-backed vault (Cloud-Files
      // placeholder risk) — only the specific files this run created.
      await cleanupCreatedFiles(createdPaths);
    });

    test('florest-cave.jpg gets expected tags and a thumbs/<sha1>.webp cache entry', async () => {
      test.setTimeout(70 * 60_000);

      const { randomName, sha1 } = await test.step('drop florest-cave.jpg and hash its bytes', async () => {
        const { destPath, randomName } = await copyFixtureWithRandomName('florest-cave.jpg');
        createdPaths.push(destPath);
        const sha1 = await computeSha1(destPath);
        return { randomName, sha1 };
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
        for (const tag of EXPECTED_TAGS) {
          expect(data.tags, `tags must include "${tag}"`).toContain(tag);
        }
      });

      await test.step('wait for thumbnails-agent to write the cached thumbnail', async () => {
        const thumbPath = path.join(THUMBS_DIR, `${sha1}.webp`);

        await expect(async () => {
          await fs.access(thumbPath);
        }).toPass({ timeout: 65 * 60_000, intervals: [60_000] });

        createdPaths.push(thumbPath);
      });
    });
  }
);
