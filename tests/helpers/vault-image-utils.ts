import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { INBOX_IMAGES_DIR, PROCESSING_DIR, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from './config';

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'test-images');

// ponytail: FrontmatterData/snapshotDir/diffNewFiles/readFrontmatter are
// duplicated from vault-utils.ts on purpose — vault-utils.ts re-exports this
// file's image helpers (so ~30 existing `from '../helpers/vault-utils'`
// imports don't need to change), and importing back from vault-utils.ts here
// would make the two files circular. tsx/esbuild's ESM interop resolves that
// cycle's re-exports to `undefined` at runtime (verified — not a type-only
// concern). Keep both copies in sync if their behavior ever needs to change.
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

async function snapshotDir(dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

function diffNewFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((name) => !before.has(name));
}

async function readFrontmatter(
  notePath: string
): Promise<{ data: FrontmatterData; content: string }> {
  const raw = await fs.readFile(notePath, 'utf-8');
  const parsed = matter(raw);
  return { data: parsed.data as FrontmatterData, content: parsed.content };
}

// Vision agent's documented image-type vocabulary (agents/vision/AGENT.md) —
// this is what tags[0] must be, independent of the broader `type:` entity enum.
export const IMAGE_CATEGORY_VOCAB =
  process.env.IMAGE_CATEGORY_VOCAB?.split(',').map((s) => s.trim()) ??
  (['portrait', 'body', 'battlemap', 'scene', 'token'] as const);

// Per-run ledger of every fixture that entered the pipeline. Resolved at
// call time (not module load) so unit tests can point it at a sandbox via
// env. Cleared by global-setup.ts — its scope is exactly one run.
export function uploadedFixturesLedgerPath(): string {
  return (
    process.env.UPLOADED_FIXTURES_LEDGER ?? path.join(__dirname, '..', '..', 'tmp', 'uploaded-fixtures.jsonl')
  );
}

/**
 * Every upload path in the suite funnels through copyFixtureWithRandomName
 * (filesystem drops directly, dashboard uploads via their staging copy — see
 * helpers/image-upload.ts), so this is the single choke point enforcing
 * "no fixture enters the pipeline twice per run". The daemon dedupes inbox
 * images by content, so a second copy of the same bytes silently changes
 * what a spec is actually testing.
 *
 * ponytail: keyed on fixture filename, not sha256 — fixture bytes are unique
 * today (audited 2026-07-15); switch to content keys if byte-identical
 * fixtures ever land. Check-then-append is also not atomic across parallel
 * workers: two specs uploading the same fixture in the same instant can both
 * pass. The guard exists to catch static duplicates in the codebase, not to
 * be a concurrency barrier.
 */
async function guardAgainstDuplicateUpload(fixtureName: string, allowDuplicate: boolean): Promise<void> {
  const ledger = uploadedFixturesLedgerPath();
  let raw = '';
  try {
    raw = await fs.readFile(ledger, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const alreadyUploaded = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { fixture: string }).fixture);
  if (alreadyUploaded.includes(fixtureName) && !allowDuplicate) {
    throw new Error(
      `Image already uploaded: "${fixtureName}" entered the pipeline earlier this run (see ${ledger}). ` +
        `Each spec must use a distinct fixture — pass { allowDuplicate: true } only when re-uploading is ` +
        `the point of the test (image-duplication.spec.ts).`
    );
  }
  await fs.mkdir(path.dirname(ledger), { recursive: true });
  await fs.appendFile(ledger, JSON.stringify({ fixture: fixtureName, at: new Date().toISOString() }) + '\n', 'utf-8');
}

export async function copyFixtureWithRandomName(
  fixtureName: string,
  destDir: string = INBOX_IMAGES_DIR,
  opts: { allowDuplicate?: boolean } = {}
): Promise<{ destPath: string; randomName: string }> {
  await guardAgainstDuplicateUpload(fixtureName, opts.allowDuplicate ?? false);
  const ext = path.extname(fixtureName);
  const randomName = `IMG_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const srcPath = path.join(FIXTURES_DIR, fixtureName);
  const destPath = path.join(destDir, randomName);
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(srcPath, destPath);
  return { destPath, randomName };
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

  // Anchor to the dropped file's NTFS file ID before the daemon can rename
  // it. The vault has no per-run isolation (workers:3 spec files share one
  // vault — CLAUDE.md concurrency model), so filename-diffing alone can
  // cross-match a concurrent spec's renamed image/note. Ingestion's
  // emoji-strip and vision's slug-rename are both same-volume Path.rename()
  // calls, which preserve NTFS file ID, so this stays valid across both
  // renames. If the file's already been renamed by the time we get here
  // (rare — daemon poll is much slower than this call), fall back to the
  // pre-existing filename heuristic below.
  const originalIno = await fs
    .stat(path.join(INBOX_IMAGES_DIR, originalRandomName))
    .then((s) => s.ino)
    .catch(() => undefined);

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
        let matchedImage = renamedCandidates.find((candidate) =>
          sourceList.some((src) => src.endsWith(candidate))
        );

        // Disambiguate cross-matches from concurrent specs: a filename hit
        // alone isn't enough proof this note came from *our* drop, so verify
        // the candidate image is literally the same file, not just some
        // other new file that happened to appear in the same poll window.
        if (matchedImage && originalIno !== undefined) {
          const candidateIno = await fs
            .stat(path.join(INBOX_IMAGES_DIR, matchedImage))
            .then((s) => s.ino)
            .catch(() => undefined);
          if (candidateIno !== originalIno) {
            matchedImage = undefined;
          }
        }

        if (matchedImage) {
          result = {
            notePath,
            imagePath: path.join(INBOX_IMAGES_DIR, matchedImage),
            data: parsed.data,
            content: parsed.content,
          };
          console.log(
            `[waitForSlugNote] RESOLVED — expected: a draft referencing a renamed sibling of "${originalRandomName}" | ` +
              `actual: notePath="${notePath}" imagePath="${matchedImage}" id="${parsed.data.id}" tags=[${(parsed.data.tags ?? []).join(', ')}]`
          );
          return;
        }
      }
    }

    console.log(
      `[waitForSlugNote] poll attempt — expected: original "${originalRandomName}" renamed + a processing/*.md draft sourcing it | ` +
        `actual: originalStillInInbox=${originalStillPresent}, newInboxFiles=[${renamedCandidates.join(', ')}], newProcessingNotes=[${newNotes.join(', ')}]`
    );

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
  console.log(
    `[assertDraftInvariants] noteId="${noteId}" actual={status:"${data.status}", quality:${data.quality}, ` +
      `reviewed:${data.reviewed}, relationships:${JSON.stringify(data.relationships)}, uuid:"${data.uuid}", ` +
      `sha256:"${data.sha256}", id:"${data.id}", created:"${data.created}", updated:"${data.updated}", ` +
      `tags:${JSON.stringify(data.tags)}, source:${JSON.stringify(data.source)}}`
  );
  expect(data.status, `status — expected: "draft", actual: "${data.status}"`).toBe('draft');
  expect(data.quality, `quality — expected: 0, actual: ${data.quality}`).toBe(0);
  expect(data.reviewed, `reviewed — expected: false, actual: ${data.reviewed}`).toBe(false);
  expect(
    Array.isArray(data.relationships) && data.relationships.length === 0,
    `relationships — expected: [] (empty array), actual: ${JSON.stringify(data.relationships)}`
  ).toBeTruthy();
  expect(data.uuid, `uuid — expected format: v4 UUID, actual: "${data.uuid}"`).toMatch(UUID_V4_RE);
  expect(data.sha256, `sha256 — expected format: 64-char hex digest, actual: "${data.sha256}"`).toMatch(
    SHA256_RE
  );
  expect(data.id, `id — expected: "${noteId}" (note filename stem), actual: "${data.id}"`).toBe(noteId);
  expect(data.created, `created — expected format: YYYY-MM-DD, actual: "${data.created}"`).toMatch(DATE_RE);
  expect(data.updated, `updated — expected format: YYYY-MM-DD, actual: "${data.updated}"`).toMatch(DATE_RE);
  expect(
    Array.isArray(data.tags) && data.tags.length > 0,
    `tags — expected: non-empty array, actual: ${JSON.stringify(data.tags)}`
  ).toBeTruthy();
  expect(
    IMAGE_CATEGORY_VOCAB as readonly string[],
    `tags[0] — expected one of: [${IMAGE_CATEGORY_VOCAB.join(', ')}], actual: "${data.tags?.[0]}"`
  ).toContain(data.tags[0]);
  // suggestedQuality is injected later by the review agent (agents/review/AGENT.md),
  // not by vision — absent here is correct, not a defect.
  expect(
    Array.isArray(data.source) && data.source.length > 0,
    `source — expected: non-empty array, actual: ${JSON.stringify(data.source)}`
  ).toBeTruthy();
}

/** Asserts `actualTags` is a superset of `expectedTags`, logging both explicitly either way. */
export function assertTagsInclude(actualTags: string[], expectedTags: string[], context = 'tags'): void {
  console.log(
    `[${context}] expected to include: [${expectedTags.join(', ')}] | actual: [${(actualTags ?? []).join(', ')}]`
  );
  for (const tag of expectedTags) {
    expect(
      actualTags,
      `${context} — expected to include "${tag}", actual: [${(actualTags ?? []).join(', ')}]`
    ).toContain(tag);
  }
}
