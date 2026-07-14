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
} from './helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from './helpers/config';

// TODO: add a face-recognition assertion once that agent stage lands — for
// now this only asserts token *existence* (a sibling {stem}-token.png gets
// generated), not likeness/composition of the token image itself.

// Every portrait/body fixture already covered under tests/image-tags/ —
// token-agent only fires for those two categories (see
// agent-token-generation.spec.ts). Tags beyond tags[0] are filename-guessed,
// same caveat as the image-tags specs these mirror.
const TOKEN_ELIGIBLE_FIXTURES: { fixture: string; expectedTags: string[] }[] = [
  { fixture: 'eirc-cavalier.jpg', expectedTags: ['portrait', 'cavalier'] },
  { fixture: 'elf-ranger.jpg', expectedTags: ['portrait', 'elf', 'ranger'] },
  { fixture: 'hank-ranger.jpg', expectedTags: ['portrait', 'ranger'] },
  { fixture: 'heman-barbarian2.jpg', expectedTags: ['portrait', 'barbarian'] },
  { fixture: 'heman-barbarian3.jpg', expectedTags: ['portrait', 'barbarian'] },
  { fixture: 'vingador.jpg', expectedTags: ['portrait'] },
  { fixture: 'dragon-blue.jpg', expectedTags: ['body', 'dragon', 'blue'] },
  { fixture: 'dragon-red.jpg', expectedTags: ['body', 'dragon', 'red'] },
  { fixture: 'dragon-white.jpg', expectedTags: ['body', 'dragon', 'white'] },
];

test.describe.serial('Token generation: every portrait/body image-tag fixture gets a sibling token', () => {
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
      console.log(`[token] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  for (const { fixture, expectedTags } of TOKEN_ELIGIBLE_FIXTURES) {
    test(`${fixture} produces a sibling {stem}-token.png after tagging`, async () => {
      const { randomName } = await test.step(`drop ${fixture} under a random name`, async () => {
        const dropped = await copyFixtureWithRandomName(fixture);
        createdPaths.push(dropped.destPath);
        return dropped;
      });

      const { notePath, imagePath, data } = await test.step(
        'wait for the vision daemon to rename the image and write a draft note',
        () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
      );
      createdPaths.push(notePath, imagePath);
      const noteId = path.basename(notePath, '.md');

      await test.step('validate current state', () => {
        assertDraftInvariants(data, noteId);
      });

      await test.step('validate tags', () => {
        assertTagsInclude(data.tags, expectedTags, fixture);
      });

      // ponytail: 3min ceiling, same reasoning as agent-token-generation.spec.ts
      // — token-agent runs the same cycle right after vision and is CV-only
      // (llm: none), so should be fast.
      await test.step('wait for token-agent to generate the sibling token image', async () => {
        const stem = path.basename(imagePath, path.extname(imagePath));
        const tokenPath = path.join(INBOX_IMAGES_DIR, `${stem}-token.png`);

        await expect(async () => {
          await fs.access(tokenPath);
        }).toPass({ timeout: 3 * 60_000, intervals: [5_000] });

        createdPaths.push(tokenPath);
      });
    });
  }
});
