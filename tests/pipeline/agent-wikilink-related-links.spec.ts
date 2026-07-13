import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  assertTagsInclude,
  readFrontmatter,
  hasSection,
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { promoteToLibrary } from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/orc1.spec.ts + orc2.spec.ts, both
// expecting the same tags). Correct from observed output after the first
// real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'orc'];

// wikilink-agent's interval is overridden to 300s at install time
// (overrideAgentSchedules, helpers/nexus-install.ts), but vision (also 300s)
// must process both drops first and there's no in-scope way to force-trigger
// either. Tagged @slow-agent (see package.json test:pipeline:fast/:slow) with
// its own 30min budget instead of being skipped.
test.describe.serial(
  'wikilink-agent: two same-tag Library notes get cross-referenced',
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
        console.log(`[agent-wikilink-related-links] FAILED — files copied for inspection to ${dir}`);
      }
    });

    test.afterAll(async () => {
      // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
      // spec that deletes files — this just hands off what this run created.
      await registerCreatedPaths(createdPaths);
    });

    test('orc1 and orc2 (both tagged "orc") get linked in each other\'s ## Related', async () => {
      test.setTimeout(30 * 60_000);

      const dropAndPromote = async (fixture: string) => {
        const { randomName } = await copyFixtureWithRandomName(fixture);
        createdPaths.push(path.join(INBOX_IMAGES_DIR, randomName));

        const { notePath, imagePath, data } = await waitForSlugNote(
          randomName,
          inboxBaseline,
          processingBaseline
        );
        createdPaths.push(notePath, imagePath);
        assertDraftInvariants(data, path.basename(notePath, '.md'));
        assertTagsInclude(data.tags, EXPECTED_TAGS, fixture);

        const { libraryNotePath, data: promoted } = await promoteToLibrary(notePath);
        createdPaths.push(libraryNotePath);
        return { libraryNotePath, id: promoted.id };
      };

      const [orc1, orc2] = await test.step(
        'drop orc1.jpg and orc2.jpg, wait for drafts, promote both to Library',
        () => Promise.all([dropAndPromote('orc1.jpg'), dropAndPromote('orc2.jpg')])
      );

      await test.step('wait for wikilink-agent to cross-reference the two notes', async () => {
        await expect(async () => {
          const [note1, note2] = await Promise.all([
            readFrontmatter(orc1.libraryNotePath),
            readFrontmatter(orc2.libraryNotePath),
          ]);

          const note1LinksNote2 = hasSection(note1.content, 'Related') && note1.content.includes(`[[${orc2.id}]]`);
          const note2LinksNote1 = hasSection(note2.content, 'Related') && note2.content.includes(`[[${orc1.id}]]`);
          console.log(
            `[agent-wikilink-related-links] expected: [[${orc2.id}]] in ${orc1.id}'s ## Related OR [[${orc1.id}]] in ${orc2.id}'s ## Related | ` +
              `actual: note1LinksNote2=${note1LinksNote2}, note2LinksNote1=${note2LinksNote1}`
          );

          expect(
            note1LinksNote2 || note2LinksNote1,
            `Still waiting for a [[wikilink]] between ${orc1.id} and ${orc2.id} in either note's ## Related section. ` +
              `actual: note1LinksNote2=${note1LinksNote2}, note2LinksNote1=${note2LinksNote1}`
          ).toBeTruthy();
        }).toPass({ timeout: 25 * 60_000, intervals: [30_000] });
      });
    });
  }
);
