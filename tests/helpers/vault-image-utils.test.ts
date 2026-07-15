// Unit tests for vault-image-utils.ts — pure fs/logic against real temp
// directories, no Playwright test runner, no real Nexus install or daemon.
// Run with: npm run test:unit (node's built-in test runner via tsx).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point INBOX_IMAGES_DIR/PROCESSING_DIR at scratch dirs before
// vault-image-utils.ts (and the config.ts it imports) evaluate their
// module-level consts — same technique as nexus-install.test.ts.
const TMP_ROOT = path.join(os.tmpdir(), `vault-image-utils-test-${process.pid}`);
const INBOX_DIR = path.join(TMP_ROOT, '00-Inbox', 'images');
const PROCESSING_DIR = path.join(TMP_ROOT, '01-Processing');
process.env.INBOX_IMAGES_DIR = INBOX_DIR;
process.env.PROCESSING_DIR = PROCESSING_DIR;

let vim: typeof import('./vault-image-utils');

before(async () => {
  vim = await import('./vault-image-utils');
});

beforeEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(PROCESSING_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeNote(filename: string, source: string[], extra: Record<string, unknown> = {}): void {
  const fm: Record<string, unknown> = {
    id: filename.replace(/\.md$/, ''),
    tags: ['scene'],
    source,
    ...extra,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `${k}: ${JSON.stringify(v)}`
    )
    .join('\n');
  fs.writeFileSync(path.join(PROCESSING_DIR, filename), `---\n${yaml}\n---\n\nbody\n`);
}

describe('IMAGE_CATEGORY_VOCAB', () => {
  test('defaults to the documented vision agent vocabulary', () => {
    assert.deepEqual(vim.IMAGE_CATEGORY_VOCAB, ['portrait', 'body', 'battlemap', 'scene', 'token']);
  });
});

describe('copyFixtureWithRandomName', () => {
  test('copies the fixture bytes under a randomized IMG_<ts>_<hex>.<ext> name', async () => {
    const destDir = path.join(TMP_ROOT, 'dest-1');
    const { destPath, randomName } = await vim.copyFixtureWithRandomName('axe.jpg', destDir);

    assert.equal(path.basename(destPath), randomName);
    assert.match(randomName, /^IMG_\d+_[0-9a-f]{8}\.jpg$/);

    const fixtureBytes = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'test-images', 'axe.jpg')
    );
    assert.deepEqual(fs.readFileSync(destPath), fixtureBytes);
  });

  test('creates destDir recursively when it does not exist yet', async () => {
    const destDir = path.join(TMP_ROOT, 'nested', 'does', 'not', 'exist');
    const { destPath } = await vim.copyFixtureWithRandomName('axe.jpg', destDir);
    assert.ok(fs.existsSync(destPath));
  });

  test('two calls produce different random names', async () => {
    const destDir = path.join(TMP_ROOT, 'dest-2');
    const a = await vim.copyFixtureWithRandomName('axe.jpg', destDir);
    const b = await vim.copyFixtureWithRandomName('axe.jpg', destDir);
    assert.notEqual(a.randomName, b.randomName);
  });
});

describe('waitForSlugNote', () => {
  test('resolves via NTFS inode match, ignoring a same-window decoy that only matches by filename', async () => {
    fs.writeFileSync(path.join(INBOX_DIR, 'original.jpg'), 'original-bytes');
    const inboxBaseline = new Set<string>(); // empty — captured before the drop, like real specs do
    const processingBaseline = new Set<string>();

    const pending = vim.waitForSlugNote('original.jpg', inboxBaseline, processingBaseline, {
      timeout: 3000,
      intervals: [30],
    });

    // Let the function's own fs.stat capture the original inode before we
    // mutate anything, mirroring the real gap between drop and daemon pickup.
    await sleep(15);

    // Simulate the daemon: rename our file in place (real sibling, same
    // inode) AND drop an unrelated new file (decoy, different inode) whose
    // note happens to be scanned in the same poll window.
    fs.renameSync(path.join(INBOX_DIR, 'original.jpg'), path.join(INBOX_DIR, 'true-sibling.jpg'));
    fs.writeFileSync(path.join(INBOX_DIR, 'decoy-sibling.jpg'), 'unrelated-bytes');
    writeNote('decoy-note.md', ['decoy-sibling.jpg']);
    writeNote('true-note.md', ['true-sibling.jpg']);

    const result = await pending;

    assert.equal(path.basename(result.notePath), 'true-note.md');
    assert.equal(path.basename(result.imagePath), 'true-sibling.jpg');
  });

  test('never resolves to a filename-matching decoy with a different inode — times out instead', async () => {
    fs.writeFileSync(path.join(INBOX_DIR, 'original.jpg'), 'original-bytes');
    const inboxBaseline = new Set<string>();
    const processingBaseline = new Set<string>();

    const pending = vim.waitForSlugNote('original.jpg', inboxBaseline, processingBaseline, {
      timeout: 300,
      intervals: [30],
    });

    await sleep(15);
    // Original disappears (as if renamed elsewhere) but only an unrelated
    // decoy note/image pair ever shows up — no genuine sibling exists.
    fs.rmSync(path.join(INBOX_DIR, 'original.jpg'));
    fs.writeFileSync(path.join(INBOX_DIR, 'decoy-sibling.jpg'), 'unrelated-bytes');
    writeNote('decoy-note.md', ['decoy-sibling.jpg']);

    await assert.rejects(() => pending);
  });

  test('falls back to filename-only matching when the original is already gone before the inode can be captured', async () => {
    // Never create the original file at all — the function's initial
    // fs.stat fails immediately, so originalIno is undefined and the ino
    // check is skipped entirely (old behavior preserved as a fallback).
    fs.writeFileSync(path.join(INBOX_DIR, 'sibling.jpg'), 'bytes');
    writeNote('note.md', ['sibling.jpg']);

    const result = await vim.waitForSlugNote('never-existed.jpg', new Set(), new Set(), {
      timeout: 1000,
      intervals: [30],
    });

    assert.equal(path.basename(result.notePath), 'note.md');
    assert.equal(path.basename(result.imagePath), 'sibling.jpg');
  });
});

function validData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scene-interior-01',
    uuid: '11111111-1111-4111-8111-111111111111',
    type: 'location',
    status: 'draft',
    quality: 0,
    created: '2026-07-15',
    updated: '2026-07-15',
    tags: ['scene', 'interior'],
    source: ['00-Inbox/images/scene-interior-01.jpg'],
    reviewed: false,
    relationships: [] as unknown[],
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('assertDraftInvariants', () => {
  test('does not throw for fully valid data', () => {
    const data = validData();
    assert.doesNotThrow(() => vim.assertDraftInvariants(data as never, data.id));
  });

  const violations: Array<[string, Record<string, unknown>, RegExp?]> = [
    ['status not "draft"', { status: 'review' }],
    ['quality not 0', { quality: 5 }],
    ['reviewed not false', { reviewed: true }],
    ['relationships not empty', { relationships: ['[[foo]]'] }],
    ['uuid not v4 format', { uuid: 'not-a-uuid' }, /uuid/],
    ['sha256 wrong length', { sha256: 'abc' }, /sha256/],
    ['id does not match noteId', { id: 'wrong-id' }, /id —/],
    ['created not YYYY-MM-DD', { created: '07-15-2026' }],
    ['updated not YYYY-MM-DD', { updated: 'yesterday' }],
    ['tags empty', { tags: [] }, /tags —/],
    ['tags[0] not in IMAGE_CATEGORY_VOCAB', { tags: ['weapon', 'axe'] }, /tags\[0\]/],
    ['source empty', { source: [] }, /source —/],
  ];

  for (const [description, overrides, messageRe] of violations) {
    test(`throws when ${description}`, () => {
      const data = validData(overrides);
      const fn = () => vim.assertDraftInvariants(data as never, 'scene-interior-01');
      if (messageRe) assert.throws(fn, messageRe);
      else assert.throws(fn);
    });
  }
});

describe('assertTagsInclude', () => {
  test('does not throw when actualTags is a superset of expectedTags', () => {
    assert.doesNotThrow(() => vim.assertTagsInclude(['scene', 'interior', 'extra'], ['scene', 'interior']));
  });

  test('does not throw when expectedTags is empty', () => {
    assert.doesNotThrow(() => vim.assertTagsInclude(['scene'], []));
  });

  test('throws naming the missing tag', () => {
    assert.throws(() => vim.assertTagsInclude(['scene'], ['scene', 'axe']), /"axe"/);
  });
});
