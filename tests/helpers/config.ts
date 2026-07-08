import path from 'node:path';

export const VAULT_PATH = path.resolve(process.env.VAULT_PATH ?? path.join('.testing', 'vault'));

export const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:48080';

// Real backlog contention observed 2026-07-07: the daemon worked through a
// large RAW/ queue for 3+ cycles (~50min) before reaching a freshly dropped
// file. Budget under the 90min Playwright test timeout, with margin.
export const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 85 * 60_000);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);

export const INBOX_IMAGES_DIR = path.join(VAULT_PATH, '00-Inbox', 'images');
export const PROCESSING_DIR = path.join(VAULT_PATH, '01-Processing');
