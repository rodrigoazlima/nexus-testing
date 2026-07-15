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
} from './helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from './helpers/config';

const FIXTURE = 'waterfall-florest.jpg';

// ponytail: tags beyond [0] (the category) are guessed from the filename, not
// verified against real vision-agent output — GRAPH_REPORT.md carries no
// per-image tag ground truth for this fixture (only skeletor.jpg has one, via
// bestiary-classification.spec.ts). Correct from observed output after the
// first real run against the live daemon.
const EXPECTED_TAGS = ['scene', 'waterfall', 'forest'];

test.describe.serial('Rename scenario: random source filename must not leak into vision slug', () => {
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
      console.log(`[scenario-rename-test] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('vision slug is content-derived, independent of the random source filename', async () => {
    const { randomName } = await test.step(`drop ${FIXTURE} under a random name`, async () => {
      const dropped = await copyFixtureWithRandomName(FIXTURE);
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

    await test.step('validate rename is content-derived, not filename-derived', () => {
      // randomName carries zero content hints (IMG_<timestamp>_<hex>.ext) —
      // if the vision daemon's slug ever echoes it back verbatim or as a
      // substring, renaming stopped being content-based and started leaking
      // the source filename through.
      const randomStem = path.parse(randomName).name;
      console.log(
        `[scenario-rename-test] expected: noteId != "${randomStem}" and not containing it | actual noteId: "${noteId}"`
      );
      expect(
        noteId,
        `slug must not equal the random source filename stem — expected: != "${randomStem}", actual: "${noteId}"`
      ).not.toBe(randomStem);
      expect(
        noteId,
        `slug must not contain the random source filename stem — expected: not containing "${randomStem}", actual: "${noteId}"`
      ).not.toContain(randomStem);
    });

    await test.step('validate current state', () => {
      assertDraftInvariants(data, noteId);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`${FIXTURE} tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }
});
