import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  readFrontmatter,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
  type FrontmatterData,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { promoteToLibrary, archiveNote } from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/presto-magician.spec.ts). Correct
// from observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'magician'];

// 99-Archive is a purely human/manual stage (AGENTS.md: "never delete
// approved content — archive instead"), same as 02-Library promotion — no
// active agent performs either, so this simulates both human steps in
// sequence: draft -> approved/Library -> archived/99-Archive.
test.describe.serial('99-Archive stage: retiring an approved note sets status: archived', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let data: FrontmatterData;
  let notePath: string;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[stage-archive] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('presto-magician image gets a fresh, valid draft', async () => {
    const { randomName } = await test.step('drop presto-magician image under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('presto-magician.jpg');
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

    await test.step('assert frontmatter invariants on the fresh draft', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`presto-magician.jpg tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }

  test('archived note keeps valid frontmatter at its new 99-Archive path', async () => {
    const { libraryNotePath } = await test.step(
      'simulate human review: approve + promote into 02-Library',
      () => promoteToLibrary(notePath)
    );
    createdPaths.push(libraryNotePath);

    const { archivedNotePath, data: archivedData } = await test.step(
      'simulate human retirement: move the approved note into 99-Archive',
      () => archiveNote(libraryNotePath)
    );
    createdPaths.push(archivedNotePath);

    await test.step('assert the archived file exists with valid frontmatter', async () => {
      await expect(async () => {
        await fs.access(archivedNotePath);
      }).toPass({ timeout: 10_000 });

      console.log(
        `[stage-archive] archivedData actual={status:"${archivedData.status}", id:"${archivedData.id}"}`
      );
      expect(
        archivedData.status,
        `status — expected: "archived", actual: "${archivedData.status}"`
      ).toBe('archived');
      const { data: reRead } = await readFrontmatter(archivedNotePath);
      expect(reRead.status, `re-read status — expected: "archived", actual: "${reRead.status}"`).toBe(
        'archived'
      );
      expect(reRead.id, `re-read id — expected: "${archivedData.id}", actual: "${reRead.id}"`).toBe(
        archivedData.id
      );
    });
  });
});
