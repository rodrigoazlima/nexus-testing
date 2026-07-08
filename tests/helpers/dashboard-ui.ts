import { Page, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FrontmatterData } from './vault-utils';

// Selectors below were confirmed against the live dashboard at
// http://localhost:48080/gm/view/{uuid} (2026-07-07) — the type/status
// controls are native <select> elements whose *accessible name* is the
// currently selected option text, and tag chips render as literal "#tag".

export async function openNoteByUuid(page: Page, uuid: string): Promise<void> {
  await page.goto(`/gm/view/${uuid}`);
  // DOM text is "Content" — the page renders it visually as "CONTENT" via
  // CSS text-transform:uppercase, which getByText's exact match doesn't see.
  await expect(page.getByText('Content', { exact: true })).toBeVisible();
}

export async function assertNoteMatchesFrontmatter(
  page: Page,
  data: FrontmatterData,
  imagePath: string
): Promise<void> {
  // Slug shown in the page's breadcrumb header.
  await expect(page.getByText(data.id, { exact: true }).first()).toBeVisible();

  // The type/status <select>s are the first two on the page (a later CHAT
  // agent-picker <select> follows) — a bare <select> has no accessible name
  // from its selected option, so match by DOM value instead of role+name.
  await expect(page.locator('select').nth(0)).toHaveValue(data.type);
  await expect(page.locator('select').nth(1)).toHaveValue(data.status);

  // One "#tag" chip per frontmatter tag.
  for (const tag of data.tags) {
    await expect(page.getByText(`#${tag}`, { exact: true })).toBeVisible();
  }

  // SRC line at the bottom of the page shows the full path to the renamed image.
  await expect(page.getByText(path.basename(imagePath), { exact: false }).first()).toBeVisible();
}

// /gm/inbox (confirmed live, 2026-07-07): a plain `<input type="file">`
// (hidden) sits behind the visible "Upload" button. The button must be
// clicked BEFORE setInputFiles — calling setInputFiles on the input directly
// silently no-ops (verified: zero network activity), the click is what
// wires up the change handler for that render.
const FILE_INPUT_SELECTOR = 'input[type="file"]';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function mimeTypeFor(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

export async function uploadViaButton(page: Page, filePath: string): Promise<void> {
  await page.goto('/gm/inbox');
  await page.getByRole('button', { name: 'Upload' }).click();
  // Empirically needed: setInputFiles immediately after click() is flaky —
  // the click's own state update needs a beat to settle before the input's
  // change handler is actually wired up to fire the upload request.
  await page.waitForTimeout(1000);
  await page.locator(FILE_INPUT_SELECTOR).last().setInputFiles(filePath);
}

/**
 * No dedicated dropzone element was found on /gm/inbox — the whole page
 * accepts a drop (verified: body/main/h1/html all trigger the same upload
 * request), so `main` is used as a stable, semantically-relevant target.
 */
export async function uploadViaDragAndDrop(page: Page, filePath: string): Promise<void> {
  await page.goto('/gm/inbox');
  // Empirically needed: dispatching the drop immediately after navigation is
  // flaky (the page isn't done hydrating yet) — same class of issue as the
  // upload-button click needing a settle beat.
  await page.waitForTimeout(1000);
  const bytes = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const mimeType = mimeTypeFor(fileName);

  const dataTransfer = await page.evaluateHandle(
    ({ bytes, fileName, mimeType }) => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType });
      dt.items.add(file);
      return dt;
    },
    { bytes: Array.from(bytes), fileName, mimeType }
  );

  const dropTarget = page.locator('main');
  await dropTarget.dispatchEvent('dragenter', { dataTransfer });
  await dropTarget.dispatchEvent('dragover', { dataTransfer });
  await dropTarget.dispatchEvent('drop', { dataTransfer });
}
