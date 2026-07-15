import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from './config';
import { NEXUS_PATH } from './nexus-install';

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

export async function readFrontmatter(
  notePath: string
): Promise<{ data: FrontmatterData; content: string }> {
  const raw = await fs.readFile(notePath, 'utf-8');
  const parsed = matter(raw);
  return { data: parsed.data as FrontmatterData, content: parsed.content };
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

// Image-pipeline helpers (IMAGE_CATEGORY_VOCAB, waitForSlugNote,
// assertDraftInvariants, assertTagsInclude, copyFixtureWithRandomName) now
// live in vault-image-utils.ts. Re-exported here so the ~30 existing
// `from '../helpers/vault-utils'` imports across tests/ don't need to change.
export {
  IMAGE_CATEGORY_VOCAB,
  copyFixtureWithRandomName,
  waitForSlugNote,
  assertDraftInvariants,
  assertTagsInclude,
  type WaitResult,
} from './vault-image-utils';
