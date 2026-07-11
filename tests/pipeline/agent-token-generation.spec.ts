import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  assertTagsInclude,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/heman-barbarian1.spec.ts). Correct
// from observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'barbarian'];

test.describe.serial('token-agent: portrait image gets a circular token generated', () => {
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
      console.log(`[agent-token-generation] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('heman-barbarian1 portrait produces a sibling {stem}-token.png', async () => {
    const { randomName } = await test.step('drop heman-barbarian1.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('heman-barbarian1.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
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

    await test.step('assert tags[0] is a token-eligible category (portrait/body)', () => {
      expect(
        ['portrait', 'body'],
        `tags[0] — expected one of: ["portrait", "body"], actual: "${data.tags[0]}"`
      ).toContain(data.tags[0]);
    });

    await test.step('assert tags', () => {
      assertTagsInclude(data.tags, EXPECTED_TAGS, 'heman-barbarian1.jpg');
    });

    // ponytail: 3min ceiling, same reasoning as bestiary-classification.spec.ts
    // — token-agent runs the same cycle right after vision (registry.yaml
    // execution_order), and it's CV-only (llm: none) so should be fast.
    await test.step('wait for token-agent to generate the sibling token image', async () => {
      const stem = path.basename(imagePath, path.extname(imagePath));
      const tokenPath = path.join(INBOX_IMAGES_DIR, `${stem}-token.png`);

      await expect(async () => {
        await fs.access(tokenPath);
      }).toPass({ timeout: 3 * 60_000, intervals: [5_000] });

      createdPaths.push(tokenPath);
    });
  });
});
