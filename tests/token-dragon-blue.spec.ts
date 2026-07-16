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
  registerCreatedPaths,
  BESTIARY_TYPES,
  type FrontmatterData,
} from './helpers/vault-utils';
import { readPngDimensions } from './helpers/vault-image-utils';
import { INBOX_IMAGES_DIR, PROCESSING_DIR } from './helpers/config';
import {
  readJsonState,
  TOKEN_CONFIG_PATH,
  PROCESSED_IMAGES_PATH,
  type TokenConfig,
  type VisionFace,
} from './helpers/nexus-state';

// ponytail: tags beyond [0] (the category) are guessed from the filename, not
// verified against real vision-agent output — GRAPH_REPORT.md carries no
// per-image tag ground truth for this fixture (only skeletor.jpg has one, via
// bestiary-classification.spec.ts). Correct from observed output after the
// first real run against the live daemon.
const EXPECTED_TAGS = ['body', 'dragon', 'blue'];

// How far the generated token's actual pixel size may drift from
// TOKEN_CONFIG_PATH's configured `size` before it's a defect rather than
// rounding/resize noise.
const SIZE_TOLERANCE = 0.1;

test.describe.serial('Image tags + token: dragon-blue.jpg -> vision draft -> token generation', () => {
  const createdPaths: string[] = [];
  let inboxBaseline: Set<string>;
  let processingBaseline: Set<string>;
  let data: FrontmatterData;
  let notePath: string;
  let imagePath: string;
  let noteId: string;

  test.beforeAll(async () => {
    inboxBaseline = await snapshotDir(INBOX_IMAGES_DIR);
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[token-dragon-blue] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Cleanup centralized: stage-inbox-exclusion.spec.ts is now the only
    // spec that deletes files — this just hands off what this run created.
    await registerCreatedPaths(createdPaths);
  });

  test('dragon-blue.jpg gets expected name and draft state', async () => {
    const { randomName } = await test.step('drop dragon-blue.jpg under a random name', async () => {
      const dropped = await copyFixtureWithRandomName('dragon-blue.jpg');
      createdPaths.push(dropped.destPath);
      return dropped;
    });

    const { notePath: freshNotePath, imagePath: freshImagePath, data: freshData } = await test.step(
      'wait for the vision daemon to rename the image and write a draft note',
      () => waitForSlugNote(randomName, inboxBaseline, processingBaseline)
    );
    createdPaths.push(freshNotePath, freshImagePath);
    notePath = freshNotePath;
    imagePath = freshImagePath;
    data = freshData;
    noteId = path.basename(notePath, '.md');

    await test.step('validate name', () => {
      expect(data.id, `id — expected: "${noteId}" (note filename stem), actual: "${data.id}"`).toBe(noteId);
    });

    await test.step('validate current state', () => {
      assertDraftInvariants(data, noteId);
    });
  });

  for (const tag of EXPECTED_TAGS) {
    test(`dragon-blue.jpg tags include "${tag}"`, () => {
      expect(data.tags, `tags — expected to include "${tag}", actual: [${(data.tags ?? []).join(', ')}]`).toContain(
        tag
      );
    });
  }

  // ponytail: 3min ceiling matches bestiary-classification.spec.ts — this
  // agent is due immediately after vision, so a tight budget fails fast.
  test('dragon-blue.jpg gets classified into the bestiary and shows on the dashboard', async ({ page }) => {
    const { data: enrichedData } = await test.step(
      'wait for the classification agent to place dragon-blue.jpg in the bestiary',
      () =>
        pollNoteUntil(
          notePath,
          (d) => (BESTIARY_TYPES as readonly string[]).includes(d.type),
          (d) =>
            `Still waiting for classification. type="${d?.type}" ` +
            `— want type in [${BESTIARY_TYPES.join(', ')}].`,
          { timeout: 3 * 60_000 }
        )
    );

    await test.step('assert bestiary type', () => {
      expect(
        BESTIARY_TYPES as readonly string[],
        `type — expected one of: [${BESTIARY_TYPES.join(', ')}], actual: "${enrichedData.type}"`
      ).toContain(enrichedData.type);
    });

    await test.step('assert dragon-blue.jpg shows up on the dashboard bestiary page', async () => {
      await page.goto('/gm/bestiary');
      await expect(page.getByText(noteId, { exact: true }).first()).toBeVisible();
    });
  });

  // ponytail: 3min ceiling, same reasoning as agent-token-generation.spec.ts —
  // token-agent runs the same cycle right after vision and is CV-only (llm:
  // none), so the sibling token should exist within one runtime loop.
  test('dragon-blue.jpg token is within 10% of the configured size, with a structurally sane face point', async () => {
    const tokenPath = await test.step('wait for token-agent to generate the sibling token image', async () => {
      const stem = path.basename(imagePath, path.extname(imagePath));
      const tp = path.join(INBOX_IMAGES_DIR, `${stem}-token.png`);

      await expect(async () => {
        await fs.access(tp);
      }).toPass({ timeout: 3 * 60_000, intervals: [5_000] });

      createdPaths.push(tp);
      return tp;
    });

    await test.step('token pixel size is within 10% of the configured size', async () => {
      const cfg = await readJsonState<TokenConfig>(TOKEN_CONFIG_PATH);
      const { width, height } = await readPngDimensions(tokenPath);
      const min = cfg.size * (1 - SIZE_TOLERANCE);
      const max = cfg.size * (1 + SIZE_TOLERANCE);
      console.log(`[token size] configured=${cfg.size} actual=${width}x${height} tolerance=±${SIZE_TOLERANCE * 100}%`);
      expect(width, `token width — expected within 10% of ${cfg.size}, actual: ${width}`).toBeGreaterThanOrEqual(min);
      expect(width, `token width — expected within 10% of ${cfg.size}, actual: ${width}`).toBeLessThanOrEqual(max);
      expect(height, `token height — expected within 10% of ${cfg.size}, actual: ${height}`).toBeGreaterThanOrEqual(
        min
      );
      expect(height, `token height — expected within 10% of ${cfg.size}, actual: ${height}`).toBeLessThanOrEqual(max);
    });

    // Structural check only, per AGENTS.md ("never assert on LLM/CV-generated
    // content, structural invariants only") — there's no verified ground-truth
    // face box for this fixture, so this can't assert *where* the face should
    // be, only that whatever token.py recorded is geometrically sane (this is
    // exactly the class of bug found on body-dragon-air, see
    // docs/dev-feedback/02-dragon-air.md: a stale/incorrect token whose crop
    // didn't match either a real face or the documented fallback).
    await test.step('face-detection point (if any) is within image bounds', async () => {
      const visionState = await readJsonState<{ images: Record<string, { face?: VisionFace }> }>(
        PROCESSED_IMAGES_PATH
      );
      const entry = visionState.images[data.sha256];
      const face = entry?.face;

      if (!face) {
        console.log(
          `[face point] no face recorded for sha256=${data.sha256} — upper-center fallback crop expected (dragon body art commonly has no detectable face, see docs/dev-feedback/02-dragon-air.md)`
        );
        return;
      }

      console.log(`[face point] recorded face=${JSON.stringify(face)}`);
      expect(face.w, `face.w — expected: >0, actual: ${face.w}`).toBeGreaterThan(0);
      expect(face.h, `face.h — expected: >0, actual: ${face.h}`).toBeGreaterThan(0);
      expect(
        face.cx,
        `face.cx — expected: within [0, ${face.img_w}], actual: ${face.cx}`
      ).toBeGreaterThanOrEqual(0);
      expect(face.cx, `face.cx — expected: within [0, ${face.img_w}], actual: ${face.cx}`).toBeLessThanOrEqual(
        face.img_w
      );
      expect(
        face.cy,
        `face.cy — expected: within [0, ${face.img_h}], actual: ${face.cy}`
      ).toBeGreaterThanOrEqual(0);
      expect(face.cy, `face.cy — expected: within [0, ${face.img_h}], actual: ${face.cy}`).toBeLessThanOrEqual(
        face.img_h
      );
    });
  });
});
