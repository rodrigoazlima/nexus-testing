import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  copyForInspection,
  copyNexusDiagnostics,
  registerCreatedPaths,
} from './helpers/vault-utils';
import { FIXTURES_DIR } from './helpers/vault-image-utils';
import { INBOX_IMAGES_DIR } from './helpers/config';

// TODO: add a face-recognition assertion once that agent stage lands — for
// now this only asserts token *existence* (a sibling {stem}-token.png gets
// generated), not likeness/composition of the token image itself.

// This spec uploads NOTHING. Each fixture below is dropped exactly once by
// its tests/image-tags/ spec; the `token-after-image-tags` project in
// playwright.config.ts guarantees this file starts only after every
// image-tags spec finished, i.e. every image is already renamed + processed.
// The already-uploaded image is located by byte-equality against the fixture
// file — ingestion's emoji-strip and vision's slug-rename are same-volume
// renames, so the bytes never change (fixture bytes are unique across
// tests/fixtures/test-images, sha256-audited 2026-07-15).
//
// Known ordering hazard, accepted: stage-inbox-exclusion.spec.ts (chromium
// project, runs concurrently with image-tags) drains the created-paths
// registry and deletes whatever the already-finished image-tags specs
// registered. If that drain lands between an image-tags spec's afterAll and
// this project starting, the byte-match below fails — the error message
// names this case. Same accepted-risk family as the drain race documented in
// scripts/run-playwright.ts.
const TOKEN_ELIGIBLE_FIXTURES: string[] = [
  'eirc-cavalier.jpg',
  'elf-ranger.jpg',
  'hank-ranger.jpg',
  'heman-barbarian2.jpg',
  'heman-barbarian3.jpg',
  'vingador.jpg',
  'dragon-red.jpg',
  'dragon-white.jpg',
];

/**
 * Finds the processed (slug-renamed) copy of a fixture in the inbox by byte
 * equality. Skips IMG_*-named files (another spec's not-yet-processed drop)
 * and *-token.png siblings (token-agent output, derived bytes).
 */
async function findUploadedImage(fixtureName: string): Promise<string | undefined> {
  const fixtureBytes = await fs.readFile(path.join(FIXTURES_DIR, fixtureName));
  let entries: string[];
  try {
    entries = await fs.readdir(INBOX_IMAGES_DIR);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (name.startsWith('IMG_') || name.endsWith('-token.png')) continue;
    const candidate = path.join(INBOX_IMAGES_DIR, name);
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== fixtureBytes.length) continue;
    if ((await fs.readFile(candidate)).equals(fixtureBytes)) return candidate;
  }
  return undefined;
}

test.describe.serial('Token generation: every already-uploaded portrait/body fixture has a sibling token', () => {
  const createdPaths: string[] = [];

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

  for (const fixture of TOKEN_ELIGIBLE_FIXTURES) {
    test(`${fixture} (uploaded by its image-tags spec) has a sibling {stem}-token.png`, async () => {
      const imagePath = await test.step('locate the already-uploaded image by byte match', async () => {
        const found = await findUploadedImage(fixture);
        expect(
          found,
          `no inbox image byte-matches "${fixture}" — expected tests/image-tags/${path.basename(fixture, path.extname(fixture))}.spec.ts ` +
            `to have uploaded and processed it before this project ran. Either that spec failed upstream, or ` +
            `stage-inbox-exclusion.spec.ts drained the cleanup registry after it registered (known ordering hazard, see file header).`
        ).toBeTruthy();
        return found!;
      });

      // ponytail: 3min ceiling, same reasoning as agent-token-generation.spec.ts
      // — token-agent runs the same cycle right after vision and is CV-only
      // (llm: none). By this point vision finished for every fixture (the
      // image-tags project completed), so the token should exist or land
      // within one runtime loop.
      await test.step('token-agent generated the sibling token image', async () => {
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
