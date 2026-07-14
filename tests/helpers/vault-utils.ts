import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { INBOX_IMAGES_DIR, PROCESSING_DIR, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from './config';
import { NEXUS_PATH } from './nexus-install';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'test-images');

// Vision agent's documented image-type vocabulary (agents/vision/AGENT.md) —
// this is what tags[0] must be, independent of the broader `type:` entity enum.
export const IMAGE_CATEGORY_VOCAB =
  process.env.IMAGE_CATEGORY_VOCAB?.split(',').map((s) => s.trim()) ??
  (['portrait', 'body', 'battlemap', 'scene', 'token'] as const);

// Entity types the dashboard's Bestiary pillar shows (system/dashboard/src/lib/pillars.ts).
// Vision only ever assigns npc/location placeholders — reaching one of these
// requires the classification-agent's second-stage type inference to run.
export const BESTIARY_TYPES =
  process.env.BESTIARY_TYPES?.split(',').map((s) => s.trim()) ?? (['creature', 'monster', 'encounter'] as const);

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

const CREATED_PATHS_REGISTRY = path.join(__dirname, '..', '..', 'tmp', 'created-paths.jsonl');

/**
 * Hands this test's created-file paths off to a shared on-disk ledger
 * instead of deleting them itself — per-file afterAll cleanup was
 * centralized into one pipeline test (stage-inbox-exclusion.spec.ts) so that
 * "created files actually get deleted" is itself a tested pipeline stage
 * ("exclusion"), not silent per-file teardown. One appendFile() call per
 * test, one JSON array per line — safe under concurrent workers since each
 * write is a single small syscall.
 */
export async function registerCreatedPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await fs.mkdir(path.dirname(CREATED_PATHS_REGISTRY), { recursive: true });
  await fs.appendFile(CREATED_PATHS_REGISTRY, JSON.stringify(paths) + '\n', 'utf-8');
}

/**
 * Deletes every path any spec has ever handed to registerCreatedPaths, then
 * clears the ledger. Ponytail: reading the file and truncating it are two
 * separate calls, so a path appended by a concurrent worker in between is
 * lost from this drain — it just sits in the (now-shorter) ledger for the
 * next exclusion-test run to pick up. Never touches a path this ledger
 * didn't list.
 */
export async function drainCreatedPathsRegistry(): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(CREATED_PATHS_REGISTRY, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const uniquePaths = [
    ...new Set(raw.split('\n').filter(Boolean).flatMap((line) => JSON.parse(line) as string[])),
  ];
  await cleanupCreatedFiles(uniquePaths);
  await fs.writeFile(CREATED_PATHS_REGISTRY, '', 'utf-8');
  return uniquePaths;
}

/**
 * Re-reads a note already located by waitForSlugNote until `predicate(data)`
 * holds — for waiting on a second-stage agent (e.g. classification) to
 * enrich a draft the vision agent already wrote. Same poll shape as
 * waitForSlugNote, but against one known path instead of a directory diff.
 */
export async function pollNoteUntil(
  notePath: string,
  predicate: (data: FrontmatterData) => boolean,
  describe: (data: FrontmatterData | undefined) => string,
  opts: { timeout?: number; intervals?: number[] } = {}
): Promise<{ data: FrontmatterData; content: string }> {
  let last: { data: FrontmatterData; content: string } | undefined;

  await expect(async () => {
    last = await readFrontmatter(notePath);
    const ok = predicate(last.data);
    console.log(`[pollNoteUntil] ${notePath} — condition met: ${ok} | ${describe(last.data)}`);
    expect(ok, describe(last.data)).toBe(true);
  }).toPass({
    timeout: opts.timeout ?? POLL_TIMEOUT_MS,
    intervals: opts.intervals ?? [POLL_INTERVAL_MS],
  });

  return last!;
}

const INSPECT_DIR = path.join(__dirname, '..', '..', 'tmp');

/**
 * Copies still-existing files (note/image paths a test pushed onto its
 * createdPaths list) into <repo root>/tmp/<label> for manual review — call
 * from an afterEach on failure, before afterAll's cleanupCreatedFiles runs.
 */
export async function copyForInspection(paths: string[], label: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(INSPECT_DIR, `${stamp}_${label.replace(/[^a-z0-9]+/gi, '-')}`);
  await fs.mkdir(dir, { recursive: true });
  for (const p of paths) {
    try {
      await fs.copyFile(p, path.join(dir, path.basename(p)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return dir;
}

/**
 * Copies NEXUS_PATH's daemon log and state JSON into an inspection dir (see
 * copyForInspection) — global-teardown.ts wipes NEXUS_PATH right after the
 * suite finishes, so on a timeout failure this is the only chance to capture
 * what the daemon actually did (2026-07-09 perf review, finding #1). Call
 * from the same afterEach, before afterAll's cleanup/teardown runs.
 */
export async function copyNexusDiagnostics(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  const automationLog = path.join(
    NEXUS_PATH,
    'agents',
    'runtime',
    'state',
    'logs',
    'automation.log'
  );
  try {
    await fs.copyFile(automationLog, path.join(dir, 'automation.log'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const stateDir = path.join(NEXUS_PATH, 'system', 'state');
  try {
    const jsonFiles = (await fs.readdir(stateDir)).filter((f) => f.endsWith('.json'));
    if (jsonFiles.length > 0) {
      const destDir = path.join(dir, 'state');
      await fs.mkdir(destDir, { recursive: true });
      await Promise.all(
        jsonFiles.map((f) => fs.copyFile(path.join(stateDir, f), path.join(destDir, f)))
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
