import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import { expect } from '@playwright/test';
import { NEXUS_PATH } from './nexus-install';
import { LIBRARY_DIR, ARCHIVE_DIR, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from './config';
import { FrontmatterData, readFrontmatter } from './vault-utils';

// Per-agent state file locations, following the same agents/<name>/state/
// pattern confirmed live for agents/lore/state/scenarios.json. Report/thumbs
// roots are inferred from agents/runtime/state/{logs,signals} sharing one
// root (agents/runtime/AGENT.md) — confirm on first live run against these
// two specific files if a poll never resolves.
export const INBOX_QUEUE_PATH = path.join(NEXUS_PATH, 'system', 'state', 'inbox-queue.json');
export const PROCESSED_IMAGES_PATH = path.join(
  NEXUS_PATH,
  'agents',
  'vision',
  'state',
  'processed-images.json'
);
export const PROCESSED_NPCS_PATH = path.join(
  NEXUS_PATH,
  'agents',
  'lore',
  'state',
  'processed-npcs.json'
);
export const SCENARIOS_PATH = path.join(NEXUS_PATH, 'agents', 'lore', 'state', 'scenarios.json');
export const WIKILINK_STATE_PATH = path.join(
  NEXUS_PATH,
  'agents',
  'wikilink',
  'state',
  'wikilink-state.json'
);
export const REPORTS_DIR = path.join(NEXUS_PATH, 'agents', 'runtime', 'state', 'reports');
export const THUMBS_DIR = path.join(NEXUS_PATH, 'system', 'state', 'thumbs');
export const DAEMON_LOGS_DIR = path.join(NEXUS_PATH, 'agents', 'runtime', 'state', 'logs');

export async function readJsonState<T>(absPath: string): Promise<T> {
  const raw = await fs.readFile(absPath, 'utf-8');
  return JSON.parse(raw) as T;
}

/** Same poll shape as vault-utils.ts's pollNoteUntil, but for a raw JSON state file. */
export async function pollJsonState<T>(
  absPath: string,
  predicate: (data: T) => boolean,
  describe: (data: T | undefined) => string,
  opts: { timeout?: number; intervals?: number[] } = {}
): Promise<T> {
  let last: T | undefined;

  await expect(async () => {
    last = await readJsonState<T>(absPath);
    const ok = predicate(last);
    console.log(`[pollJsonState] ${absPath} — condition met: ${ok} | ${describe(last)}`);
    expect(ok, describe(last)).toBe(true);
  }).toPass({
    timeout: opts.timeout ?? POLL_TIMEOUT_MS,
    intervals: opts.intervals ?? [POLL_INTERVAL_MS],
  });

  return last!;
}

async function writeFrontmatter(
  notePath: string,
  data: FrontmatterData,
  content: string
): Promise<void> {
  await fs.writeFile(notePath, matter.stringify(content, data), 'utf-8');
}

/**
 * Simulates the human review step (vault_guard.py blocks every agent from
 * doing this itself) — writes approved frontmatter and moves the note into
 * 02-Library/. Returns the new path so the caller can push it onto
 * createdPaths for cleanup.
 */
export async function promoteToLibrary(
  notePath: string,
  overrides: Partial<FrontmatterData> = {}
): Promise<{ libraryNotePath: string; data: FrontmatterData }> {
  const { data, content } = await readFrontmatter(notePath);
  const promoted: FrontmatterData = {
    ...data,
    status: 'approved',
    quality: 8,
    reviewed: true,
    relationships: data.relationships.length > 0 ? data.relationships : ['[[test-fixture-anchor]]'],
    ...overrides,
  };

  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const libraryNotePath = path.join(LIBRARY_DIR, path.basename(notePath));
  await writeFrontmatter(libraryNotePath, promoted, content);
  await fs.unlink(notePath);

  return { libraryNotePath, data: promoted };
}

/** Moves an already-approved Library note into 99-Archive/, per AGENTS.md ("never delete approved content — archive instead"). */
export async function archiveNote(
  libraryNotePath: string
): Promise<{ archivedNotePath: string; data: FrontmatterData }> {
  const { data, content } = await readFrontmatter(libraryNotePath);
  const archived: FrontmatterData = { ...data, status: 'archived' };

  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const archivedNotePath = path.join(ARCHIVE_DIR, path.basename(libraryNotePath));
  await writeFrontmatter(archivedNotePath, archived, content);
  await fs.unlink(libraryNotePath);

  return { archivedNotePath, data: archived };
}

/**
 * Flips a scenario's `active` flag to true for the duration of `fn`, then
 * restores the original file content — scenarios.json is shared config the
 * live daemon reads, not a test-owned fixture, so restoration must happen on
 * both pass and fail (finally, not afterAll — a test.step throw must not
 * leave this mutated).
 */
export async function withScenarioActive<T>(
  scenarioId: string,
  fn: () => Promise<T>
): Promise<T> {
  const original = await fs.readFile(SCENARIOS_PATH, 'utf-8');
  const scenarios = JSON.parse(original) as Array<{ id: string; active: boolean }>;
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new Error(`withScenarioActive: no scenario with id "${scenarioId}" in ${SCENARIOS_PATH}`);
  }
  scenario.active = true;
  await fs.writeFile(SCENARIOS_PATH, JSON.stringify(scenarios, null, 2), 'utf-8');

  try {
    return await fn();
  } finally {
    await fs.writeFile(SCENARIOS_PATH, original, 'utf-8');
  }
}

// ponytail: exact schema (array vs. object-keyed) of these per-agent state
// files wasn't pinned down from docs alone — searches both shapes for an
// entry whose fields mention `filename`. Correct from observed output after
// the first real run against the live daemon.
export function findEntryByFilename<T extends object>(state: unknown, filename: string): T | undefined {
  const entries = Array.isArray(state) ? state : Object.values(state as Record<string, unknown>);
  return (entries as T[]).find((entry) =>
    Object.values(entry as Record<string, unknown>).some(
      (v) => typeof v === 'string' && v.includes(filename)
    )
  );
}

export async function computeSha1(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/**
 * Creates a dummy log file backdated past cleanup-agent's cleanupDays
 * threshold (7 days) — never touches real production logs, only a file this
 * test created and owns. Returns the path so the caller can assert on it
 * disappearing (and clean it up itself if the agent never runs).
 */
export async function createStaleLogFixture(): Promise<string> {
  await fs.mkdir(DAEMON_LOGS_DIR, { recursive: true });
  const logPath = path.join(DAEMON_LOGS_DIR, `test-stale_${Date.now()}.log`);
  await fs.writeFile(logPath, `[stale test fixture] ${new Date().toISOString()}\n`, 'utf-8');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(logPath, old, old);
  return logPath;
}
