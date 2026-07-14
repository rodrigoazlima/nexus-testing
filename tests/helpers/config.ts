import path from 'node:path';

// Anchored to repo root (not process.cwd()) so the default is stable
// regardless of where npm/playwright is invoked from. ROOT_DIR itself can be
// overridden via env, but since __dirname is fixed at build time, that only
// matters if you're pointing the *other* env-driven defaults elsewhere.
export const ROOT_DIR = process.env.ROOT_DIR ?? path.resolve(__dirname, '..', '..');

export const VAULT_PATH = path.resolve(process.env.VAULT_PATH ?? path.join(ROOT_DIR, '.testing', 'vault'));

export const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:48080';

// Shortened to 10min (from 85min) per 2026-07-09 perf review: confirm/rule
// out the .env.local-wipe hypothesis fast instead of burning a full backlog
// budget on every run. Budget under the 10min Playwright test timeout.
export const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 10 * 60_000);
// Tighter than the daemon's own cadence on purpose: cost is one extra fs
// snapshot/read, and it shortens how long a passing test waits after the
// real state already flipped.
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5_000);

// Vault subdirectory layout — fixed by the Nexus daemon's own convention.
// Overridable per-path for the rare case a test needs to point at a
// non-standard layout without moving the whole vault.
export const INBOX_IMAGES_DIR = process.env.INBOX_IMAGES_DIR ?? path.join(VAULT_PATH, '00-Inbox', 'images');
export const INBOX_DOCS_DIR = process.env.INBOX_DOCS_DIR ?? path.join(VAULT_PATH, '00-Inbox', 'docs');
export const PROCESSING_DIR = process.env.PROCESSING_DIR ?? path.join(VAULT_PATH, '01-Processing');
export const LIBRARY_DIR = process.env.LIBRARY_DIR ?? path.join(VAULT_PATH, '02-Library');
export const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? path.join(VAULT_PATH, '99-Archive');
