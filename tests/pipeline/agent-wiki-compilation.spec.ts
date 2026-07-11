import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  snapshotDir,
  diffNewFiles,
  readFrontmatter,
  copyForInspection,
  copyNexusDiagnostics,
  cleanupCreatedFiles,
} from '../helpers/vault-utils';
import { INBOX_DOCS_DIR, PROCESSING_DIR } from '../helpers/config';
import { INBOX_QUEUE_PATH, readJsonState, findEntryByFilename } from '../helpers/nexus-state';

// wiki-agent only processes documents (00-Inbox/docs/), never images —
// ingestion always queues image-type drops with agents.wiki: skip. That
// makes "base it on an image-tags test" structurally impossible here; this
// reuses the same describe.serial/baseline/cleanup *skeleton* those tests
// share, with a new non-image fixture instead.
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'test-docs', 'sample-lore.md');

interface QueueEntry {
  agents: Record<string, string>;
}

test.describe.serial('wiki-agent: dropped document compiles into a Processing draft', () => {
  const createdPaths: string[] = [];
  let processingBaseline: Set<string>;

  test.beforeAll(async () => {
    processingBaseline = await snapshotDir(PROCESSING_DIR);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const dir = await copyForInspection(createdPaths, testInfo.title);
      await copyNexusDiagnostics(dir);
      console.log(`[agent-wiki-compilation] FAILED — files copied for inspection to ${dir}`);
    }
  });

  test.afterAll(async () => {
    // Never delete folders on this OneDrive-backed vault (Cloud-Files
    // placeholder risk) — only the specific files this run created.
    await cleanupCreatedFiles(createdPaths);
  });

  test('sample-lore.md compiles into a draft entity referencing it as source', async () => {
    const docName = await test.step('drop sample-lore.md into 00-Inbox/docs', async () => {
      await fs.mkdir(INBOX_DOCS_DIR, { recursive: true });
      const name = `DOC_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.md`;
      const destPath = path.join(INBOX_DOCS_DIR, name);
      await fs.copyFile(FIXTURE_PATH, destPath);
      createdPaths.push(destPath);
      return name;
    });

    const notePath = await test.step(
      'wait for wiki-agent to compile a Processing draft referencing the doc',
      async () => {
        let found: string | undefined;

        await expect(async () => {
          const processingNow = await snapshotDir(PROCESSING_DIR);
          const newNotes = diffNewFiles(processingBaseline, processingNow).filter((name) =>
            name.endsWith('.md')
          );

          for (const noteName of newNotes) {
            const candidate = path.join(PROCESSING_DIR, noteName);
            let parsed;
            try {
              parsed = await readFrontmatter(candidate);
            } catch {
              continue; // note may still be mid-write by the agent
            }
            const sourceList = Array.isArray(parsed.data.source) ? parsed.data.source : [];
            if (sourceList.some((src) => src.endsWith(docName))) {
              found = candidate;
              return;
            }
          }

          expect(found, `Still waiting for a draft referencing ${docName}.`).toBeTruthy();
        }).toPass({ timeout: 10 * 60_000, intervals: [5_000] });

        return found!;
      }
    );
    createdPaths.push(notePath);

    await test.step('assert the compiled draft has draft status', async () => {
      const { data } = await readFrontmatter(notePath);
      expect(data.status).toBe('draft');
      expect(data.id).toBe(path.basename(notePath, '.md'));
    });

    await test.step('assert inbox-queue.json marks wiki done for this document', async () => {
      const queue = await readJsonState<unknown>(INBOX_QUEUE_PATH);
      const entry = findEntryByFilename<QueueEntry>(queue, docName);
      expect(entry, `no inbox-queue.json entry found referencing ${docName}`).toBeTruthy();
      expect(entry!.agents.wiki).toBe('done');
    });
  });
});
