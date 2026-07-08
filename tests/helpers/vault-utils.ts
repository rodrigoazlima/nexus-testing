import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { INBOX_IMAGES_DIR, PROCESSING_DIR, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from './config';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'test-images');

// Vision agent's documented image-type vocabulary (agents/vision/AGENT.md) —
// this is what tags[0] must be, independent of the broader `type:` entity enum.
export const IMAGE_CATEGORY_VOCAB = ['portrait', 'body', 'battlemap', 'scene', 'token'] as const;

export interface FrontmatterData {
  id: string;
  uuid: string;
  type: string;
  status: string;
  quality: number;
  created: string;
  updated: string;
  tags: string[];
  source: string[];
  reviewed: boolean;
  relationships: unknown[];
  sha256: string;
  suggestedQuality?: number;
  [key: string]: unknown;
}

export async function snapshotDir(dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

export function diffNewFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((name) => !before.has(name));
}

export async function copyFixtureWithRandomName(
  fixtureName: string,
  destDir: string = INBOX_IMAGES_DIR
): Promise<{ destPath: string; randomName: string }> {
  const ext = path.extname(fixtureName);
  const randomName = `IMG_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const srcPath = path.join(FIXTURES_DIR, fixtureName);
  const destPath = path.join(destDir, randomName);
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(srcPath, destPath);
  return { destPath, randomName };
}

export async function readFrontmatter(
  notePath: string
): Promise<{ data: FrontmatterData; content: string }> {
  const raw = await fs.readFile(notePath, 'utf-8');
  const parsed = matter(raw);
  return { data: parsed.data as FrontmatterData, content: parsed.content };
}

export interface WaitResult {
  notePath: string;
  imagePath: string;
  data: FrontmatterData;
  content: string;
}

/**
 * Polls the vault for the vision agent's real output. There is no in-scope
 * way to force-trigger the daemon (out of scope: C:\Users\rodrigo\nexus), so
 * this waits out the actual 60s runtime loop / 900s vision interval. Success
 * = the original random-named image is gone from the inbox (renamed in
 * place) AND a new 01-Processing/*.md draft's `source:` frontmatter points at
 * the renamed sibling.
 */
export async function waitForSlugNote(
  originalRandomName: string,
  inboxBaseline: Set<string>,
  processingBaseline: Set<string>,
  opts: { timeout?: number; intervals?: number[] } = {}
): Promise<WaitResult> {
  let result: WaitResult | undefined;

  await expect(async () => {
    const [inboxNow, processingNow] = await Promise.all([
      snapshotDir(INBOX_IMAGES_DIR),
      snapshotDir(PROCESSING_DIR),
    ]);

    const renamedCandidates = diffNewFiles(inboxBaseline, inboxNow).filter(
      (name) => name !== originalRandomName
    );
    const originalStillPresent = inboxNow.has(originalRandomName);
    const newNotes = diffNewFiles(processingBaseline, processingNow).filter((name) =>
      name.endsWith('.md')
    );

    if (!originalStillPresent) {
      for (const noteName of newNotes) {
        const notePath = path.join(PROCESSING_DIR, noteName);
        let parsed: { data: FrontmatterData; content: string };
        try {
          parsed = await readFrontmatter(notePath);
        } catch {
          continue; // note may still be mid-write by the agent
        }

        const sourceList = Array.isArray(parsed.data.source) ? parsed.data.source : [];
        const matchedImage = renamedCandidates.find((candidate) =>
          sourceList.some((src) => src.endsWith(candidate))
        );

        if (matchedImage) {
          result = {
            notePath,
            imagePath: path.join(INBOX_IMAGES_DIR, matchedImage),
            data: parsed.data,
            content: parsed.content,
          };
          return;
        }
      }
    }

    expect(
      result,
      `Still waiting for a draft note referencing a renamed sibling of "${originalRandomName}". ` +
        `Original still in inbox: ${originalStillPresent}. ` +
        `New inbox files seen: [${renamedCandidates.join(', ')}]. ` +
        `New processing notes seen: [${newNotes.join(', ')}].`
    ).toBeTruthy();
  }).toPass({
    timeout: opts.timeout ?? POLL_TIMEOUT_MS,
    intervals: opts.intervals ?? [POLL_INTERVAL_MS],
  });

  return result!;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Structural invariants only — never assert on exact LLM-generated prose. */
export function assertDraftInvariants(data: FrontmatterData, noteId: string): void {
  expect(data.status, 'fresh vision-agent drafts must be status: draft').toBe('draft');
  expect(data.quality, 'fresh drafts start at quality: 0').toBe(0);
  expect(data.reviewed, 'agents may never set reviewed: true (vault_guard.py)').toBe(false);
  expect(
    Array.isArray(data.relationships) && data.relationships.length === 0,
    'fresh drafts start with no relationships'
  ).toBeTruthy();
  expect(data.uuid, 'uuid must be a v4 UUID').toMatch(UUID_V4_RE);
  expect(data.sha256, 'sha256 must be a 64-char hex digest').toMatch(SHA256_RE);
  expect(data.id, 'id must equal the note filename stem').toBe(noteId);
  expect(data.created, 'created must be YYYY-MM-DD').toMatch(DATE_RE);
  expect(data.updated, 'updated must be YYYY-MM-DD').toMatch(DATE_RE);
  expect(Array.isArray(data.tags) && data.tags.length > 0, 'tags must be non-empty').toBeTruthy();
  expect(
    IMAGE_CATEGORY_VOCAB as readonly string[],
    `tags[0] must be a known image category, got "${data.tags?.[0]}"`
  ).toContain(data.tags[0]);
  // suggestedQuality is injected later by the review agent (agents/review/AGENT.md),
  // not by vision — absent here is correct, not a defect.
  expect(
    Array.isArray(data.source) && data.source.length > 0,
    'source must be a non-empty array'
  ).toBeTruthy();
}

export function hasSection(content: string, heading: string): boolean {
  return new RegExp(`^##\\s+${heading}\\b`, 'm').test(content);
}

export async function cleanupCreatedFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
