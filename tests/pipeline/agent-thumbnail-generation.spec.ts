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
  registerCreatedPaths,
  type FrontmatterData,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { THUMBS_DIR, computeSha1 } from '../helpers/nexus-state';

// Verified against the live daemon 2026-07-13: vision tagged florest-cave.jpg
// [scene, nature, forest] (the filename-guessed 'cave' never appeared).
const EXPECTED_TAGS = ['scene', 'nature', 'forest'];

// thumbnails-agent's interval is overridden to 300s at install time
// (overrideAgentSchedules, helpers/nexus-install.ts), but vision (also 300s)
// must process the drop first and there's no in-scope way to force-trigger
// either. Tagged @slow-agent (see package.json test:pipeline:fast/:slow) with
// its own 30min budget instead of being skipped.
test.describe.serial(
  'thumbnails-agent: dropped image gets a 320px webp thumbnail',
  { tag: '@slow-agent' },
  () => {
    const createdPaths: string[] = [];
    let inboxBaseline: Set<string>;
    let processingBaseline: Set<string>;
    let data: FrontmatterData;
    let sha1: string;

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
      // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
      // spec that deletes files — this just hands off what this run created.
      await registerCreatedPaths(createdPaths);
    });

    test('florest-cave.jpg gets a fresh, valid draft', async () => {
      const { randomName, sha1: freshSha1 } = await test.step('drop florest-cave.jpg and hash its bytes', async () => {
        const { destPath, randomName } = await copyFixtureWithRandomName('florest-cave.jpg');
        createdPaths.push(destPath);
        const sha1 = await computeSha1(destPath);
        return { randomName, sha1 };
      });
      sha1 = freshSha1;

      const { notePath, imagePath, data: freshData } = await test.step(
        'wait for the vision daemon to rename the image and write a draft note',
        () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
      );
      createdPaths.push(notePath, imagePath);
      data = freshData;

      await test.step('assert frontmatter invariants', () => {
        const noteId = path.basename(notePath, '.md');
        assertDraftInvariants(data, noteId);
      });
    });

    for (const tag of EXPECTED_TAGS) {
      test(`florest-cave.jpg tags include "${tag}"`, () => {
        expect(
          data.tags,
          `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`
        ).toContain(tag);
      });
    }

    test('florest-cave.jpg gets a thumbs/<sha1>.webp cache entry', async () => {
      test.setTimeout(30 * 60_000);

      await test.step('wait for thumbnails-agent to write the cached thumbnail', async () => {
        const thumbPath = path.join(THUMBS_DIR, `${sha1}.webp`);

        await expect(async () => {
          await fs.access(thumbPath);
        }).toPass({ timeout: 25 * 60_000, intervals: [30_000] });

        createdPaths.push(thumbPath);
      });
    });
  }
);
