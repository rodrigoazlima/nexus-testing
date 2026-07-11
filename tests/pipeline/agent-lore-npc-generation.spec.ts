import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  readFrontmatter,
  copyForInspection,
  copyNexusDiagnostics,
  cleanupCreatedFiles,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import {
  withScenarioActive,
  PROCESSED_NPCS_PATH,
  pollJsonState,
  findEntryByFilename,
} from '../helpers/nexus-state';

const SCENARIO_ID = 'default-scenario';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/diana-acrobat.spec.ts). Correct
// from observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'acrobat'];

interface NpcEntry {
  status: string;
}

// lore-agent only acts on scenarios.json entries with active:true. The real
// vault's scenarios.json ships with one placeholder scenario, active:false —
// withScenarioActive flips it for this test's duration only and restores the
// original file in a finally block, since it's shared config the live daemon
// reads (not a test-owned fixture).
test.describe.serial('lore-agent: portrait + active scenario -> NPC draft', () => {
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
      console.log(`[agent-lore-npc-generation] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Never delete folders on this OneDrive-backed vault (Cloud-Files
    // placeholder risk) — only the specific files this run created.
    await cleanupCreatedFiles(createdPaths);
  });

  test('diana-acrobat portrait + active scenario produces an NPC draft', async () => {
    await withScenarioActive(SCENARIO_ID, async () => {
      const { randomName } = await test.step('drop diana-acrobat.jpg under a random name', async () => {
        const dropped = await copyFixtureWithRandomName('diana-acrobat.jpg');
        createdPaths.push(dropped.destPath);
        return dropped;
      });

      const { notePath, imagePath, data } = await test.step(
        'wait for the vision daemon to rename the image and write a draft note',
        () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
      );
      createdPaths.push(notePath, imagePath);

      await test.step('assert frontmatter invariants on the vision draft', () => {
        const noteId = path.basename(notePath, '.md');
        assertDraftInvariants(data, noteId);
      });

      await test.step('assert tags[0] is an NPC-eligible category (portrait/body)', () => {
        expect(['portrait', 'body']).toContain(data.tags[0]);
      });

      await test.step('assert tags', () => {
        for (const tag of EXPECTED_TAGS) {
          expect(data.tags, `tags must include "${tag}"`).toContain(tag);
        }
      });

      const npcNotePath = await test.step('wait for lore-agent to write an NPC draft', async () => {
        const stem = path.basename(imagePath, path.extname(imagePath));
        const candidate = path.join(PROCESSING_DIR, `${stem}-${SCENARIO_ID}.md`);

        await expect(async () => {
          await readFrontmatter(candidate);
        }).toPass({ timeout: 3 * 60_000, intervals: [5_000] });

        return candidate;
      });
      createdPaths.push(npcNotePath);

      await test.step('assert the NPC draft has valid frontmatter', async () => {
        const { data: npcData } = await readFrontmatter(npcNotePath);
        expect(npcData.status).toBe('draft');
        expect(npcData.id).toBe(path.basename(npcNotePath, '.md'));
      });

      await test.step('assert processed-npcs.json recorded an ok entry', async () => {
        const finalName = path.basename(npcNotePath);
        await pollJsonState<unknown>(
          PROCESSED_NPCS_PATH,
          (state) => findEntryByFilename<NpcEntry>(state, finalName)?.status === 'ok',
          (state) =>
            `Still waiting for a processed-npcs.json entry with status "ok" for ${finalName}. ` +
            `Found: ${JSON.stringify(findEntryByFilename<NpcEntry>(state, finalName))}`,
          { timeout: 60_000 }
        );
      });
    });
  });
});
