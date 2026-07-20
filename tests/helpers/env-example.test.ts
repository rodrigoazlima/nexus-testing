// Regression guard for the 2026-07-20 NEXUS_SERVICE_PASSWORD incident: a new
// process.env.* var was added to code (nexus-install.ts) with nothing forcing
// .env.example to document it, so the failure mode was discovered live
// instead of at review time. This test keeps .env.example and the actual
// process.env.* reads in tests/**, playwright.config.ts, and scripts/** in
// sync in both directions.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');

// Vars intentionally absent from .env.example: not user-facing dotenv config.
// NEXUS_TEST_KEEP is set programmatically by scripts/run-playwright.ts's
// --keep flag, never read from .env. LOCALAPPDATA/COMPUTERNAME/USERNAME are
// Windows-provided env vars this repo reads but doesn't define defaults for.
const EXPECTED_UNDOCUMENTED = new Set(['NEXUS_TEST_KEEP', 'LOCALAPPDATA', 'COMPUTERNAME', 'USERNAME']);

const SKIP_DIRS = new Set(['node_modules', '.git', '.testing', 'tmp', 'playwright-report', 'test-results']);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTsFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function findReferencedEnvVars(): Set<string> {
  const vars = new Set<string>();
  for (const file of walkTsFiles(ROOT)) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      vars.add(m[1]);
    }
  }
  return vars;
}

function findDocumentedEnvVars(): Set<string> {
  const vars = new Set<string>();
  for (const line of fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) vars.add(m[1]);
  }
  return vars;
}

describe('.env.example', () => {
  test('documents every process.env.* var read outside *.test.ts', () => {
    const referenced = findReferencedEnvVars();
    const documented = findDocumentedEnvVars();
    const missing = [...referenced].filter((v) => !documented.has(v) && !EXPECTED_UNDOCUMENTED.has(v));

    assert.deepEqual(
      missing,
      [],
      `.env.example is missing: ${missing.join(', ')}. Document every var production code reads ` +
        `via process.env (or add it to EXPECTED_UNDOCUMENTED with a reason) so a newly-required ` +
        `var fails loudly here instead of as an unclear runtime error.`
    );
  });

  test('has no stale entries for vars nothing reads anymore', () => {
    const referenced = findReferencedEnvVars();
    const documented = findDocumentedEnvVars();
    const stale = [...documented].filter((v) => !referenced.has(v));

    assert.deepEqual(stale, [], `.env.example documents vars no code reads: ${stale.join(', ')}`);
  });
});
