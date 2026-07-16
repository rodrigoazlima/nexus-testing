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
export const INBOX_QUEUE_PATH =
  process.env.INBOX_QUEUE_PATH ?? path.join(NEXUS_PATH, 'system', 'state', 'inbox-queue.json');
export const PROCESSED_IMAGES_PATH =
  process.env.PROCESSED_IMAGES_PATH ?? path.join(NEXUS_PATH, 'agents', 'vision', 'state', 'processed-images.json');
export const PROCESSED_NPCS_PATH =
  process.env.PROCESSED_NPCS_PATH ?? path.join(NEXUS_PATH, 'agents', 'lore', 'state', 'processed-npcs.json');
export const SCENARIOS_PATH =
  process.env.SCENARIOS_PATH ?? path.join(NEXUS_PATH, 'agents', 'lore', 'state', 'scenarios.json');
export const WIKILINK_STATE_PATH =
  process.env.WIKILINK_STATE_PATH ?? path.join(NEXUS_PATH, 'agents', 'wikilink', 'state', 'wikilink-state.json');
// repair-agent writes repair-{date}.json under review's reports dir, not its
// own or runtime's — verified against repair_agent.py (_REPORTS_DIR) and the
// 2026-07-13 live run.
export const REPORTS_DIR = process.env.REPORTS_DIR ?? path.join(NEXUS_PATH, 'agents', 'review', 'state', 'reports');
export const THUMBS_DIR = process.env.THUMBS_DIR ?? path.join(NEXUS_PATH, 'system', 'state', 'thumbs');
export const DAEMON_LOGS_DIR =
  process.env.DAEMON_LOGS_DIR ?? path.join(NEXUS_PATH, 'agents', 'runtime', 'state', 'logs');
// Token worker state (nexus/workers/token.py: _CONFIG_FILE / _GEN_TOKENS) —
// confirmed against a live install 2026-07-15 while investigating the
// body-dragon-air token (docs/dev-feedback/02-dragon-air.md).
export const TOKEN_CONFIG_PATH =
  process.env.TOKEN_CONFIG_PATH ??
  path.join(NEXUS_PATH, 'system', 'state', 'workers', 'token', '10-generate-tokens.json');
export const GENERATED_TOKENS_PATH =
  process.env.GENERATED_TOKENS_PATH ??
  path.join(NEXUS_PATH, 'system', 'state', 'workers', 'token', 'generated-tokens.json');

export interface TokenConfig {
  size: number;
  padding: number;
  forehead_ratio: number;
  body_ratio: number;
  focus_head: number[];
  moldura_path: string;
  moldura_by_type: Record<string, string>;
}

export interface GeneratedTokenEntry {
  sourcePath: string;
  tokenPath: string;
  generatedAt: string;
}

// Center-point face box token.py stores back onto the source image's vision
// entry (_store_face) — absent when no face was detected (upper-center
// fallback crop used instead), which is a valid, expected outcome, not a bug.
export interface VisionFace {
  cx: number;
  cy: number;
  w: number;
  h: number;
  img_w: number;
  img_h: number;
}

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
 * threshold — cleanup_agent.py purges by mtime with a 90-day default (no
 * cleanupDays in the synthesized agent.json), verified 2026-07-13 after an
 * 8-day backdate sat through three cleanup cycles untouched. Never touches
 * real production logs, only a file this test created and owns. Returns the
 * path so the caller can assert on it disappearing (and clean it up itself
 * if the agent never runs).
 */
export async function createStaleLogFixture(): Promise<string> {
  await fs.mkdir(DAEMON_LOGS_DIR, { recursive: true });
  const logPath = path.join(DAEMON_LOGS_DIR, `test-stale_${Date.now()}.log`);
  await fs.writeFile(logPath, `[stale test fixture] ${new Date().toISOString()}\n`, 'utf-8');
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  await fs.utimes(logPath, old, old);
  return logPath;
}
