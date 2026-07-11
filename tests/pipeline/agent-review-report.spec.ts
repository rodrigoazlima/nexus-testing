import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  snapshotDir,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  pollNoteUntil,
  copyForInspection,
  copyNexusDiagnostics,
  cleanupCreatedFiles,
} from '../helpers/vault-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from '../helpers/config';
import { REPORTS_DIR } from '../helpers/nexus-state';

// ponytail: tags beyond [0] are filename-guessed, not verified ground truth
// (moved from the deleted tests/image-tags/half-orc.spec.ts). Correct from
// observed output after the first real run against the live daemon.
const EXPECTED_TAGS = ['portrait', 'orc'];

test.describe.serial('review-agent: quality-0 draft gets a suggestedQuality + fresh report', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let dropTime: number;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[agent-review-report] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Never delete folders on this OneDrive-backed vault (Cloud-Files
    // placeholder risk) — only the specific files this run created.
    await cleanupCreatedFiles(createdPaths);
  });

  test('half-orc draft gets suggestedQuality injected and the daily report refreshes', async () => {
    dropTime = Date.now();
    const { randomName } = await test.step('drop half-orc.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('half-orc.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath, imagePath, data } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(notePath, imagePath);

    await test.step('assert frontmatter invariants (quality: 0, no suggestedQuality yet)', () => {
      const noteId = path.basename(notePath, '.md');
      assertDraftInvariants(data, noteId);
      expect(data.suggestedQuality, 'suggestedQuality is injected later by review-agent').toBeUndefined();
    });

    await test.step('assert tags', () => {
      for (const tag of EXPECTED_TAGS) {
        expect(data.tags, `tags must include "${tag}"`).toContain(tag);
      }
    });

    await test.step('wait for review-agent to inject suggestedQuality', () =>
      pollNoteUntil(
        notePath,
        (d) => typeof d.suggestedQuality === 'number',
        (d) => `Still waiting for suggestedQuality. Current: ${JSON.stringify(d?.suggestedQuality)}`,
        { timeout: 5 * 60_000 }
      )
    );

    await test.step('assert today\'s report file was refreshed after the drop', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const reportPath = path.join(REPORTS_DIR, `report-${today}.json`);

      await expect(async () => {
        const stat = await fs.stat(reportPath);
        expect(stat.mtimeMs, `${reportPath} must have been written after the test's drop`).toBeGreaterThanOrEqual(
          dropTime
        );
      }).toPass({ timeout: 60_000, intervals: [5_000] });
    });
  });
});
