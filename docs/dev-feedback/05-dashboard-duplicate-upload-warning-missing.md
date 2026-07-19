# QA Feedback: dashboard never shows an "Image already uploaded" warning — the text doesn't exist anywhere in the app

**Reported by:** `tests/pipeline/image-duplication.spec.ts:70` (`re-uploading master.jpg is ignored and warns "Image already uploaded"`)
**Symptom:** After re-uploading identical bytes via the inbox page's own "Upload" button, `page.getByText('Image already uploaded', { exact: false })` never becomes visible within 30s. The backend correctly detects and rejects the duplicate — the failure is purely a missing (or unreachable) UI signal.

This document only analyzes — no code was changed while producing it. This confirms the spec's own `ponytail:` comment (`image-duplication.spec.ts:21-24`): *"if the dashboard lacks upload-time dedupe, this spec fails and that's the finding."*

---

## Root Cause

### The backend dedupe works correctly
`system/dashboard/src/app/api/gm/upload-image/route.ts:57-67` hashes the uploaded bytes (blake2b, matching `nexus.shared.hashing`), checks `findImageHashClaim`/`findImageByHash`, and on a match returns:

```ts
return NextResponse.json({ ok: true, duplicate: true, path: existing.path, originalName: existing.originalName })
```

No file is written for a duplicate. This part is fine.

### The button-upload flow (what the test drives) never surfaces `duplicate` at all
`ImageUpload.viaButton` (`tests/helpers/image-upload.ts:42-46`) drives `uploadViaButton` (`tests/helpers/dashboard-ui.ts:60-68`), which clicks `/gm/inbox`'s own "Upload" button and sets the hidden file input. That input's `onChange` calls `handleFilesSelected` (`system/dashboard/src/app/gm/inbox/page.tsx:84-94`):

```tsx
const handleFilesSelected = useCallback(async (fileList: FileList | null) => {
  const files = Array.from(fileList ?? []).filter(isImageFile)
  if (files.length === 0) return
  setUploading(true)
  await Promise.all(files.map(async (f) => {
    const result = await uploadImage({ file: f })
    if (result.ok && result.path && !result.duplicate) await enqueueImage(result.path)
  }))
  setUploading(false)
  loadPage(0)
}, [loadPage])
```

`result.duplicate` is checked only to *skip* `enqueueImage` — there is no branch anywhere in `page.tsx` that renders any text, toast, or indicator when a duplicate is detected. The user (and this test) gets zero feedback; the upload just silently no-ops.

### The only UI that acknowledges duplicates at all is a different component, on a different flow, with different text
`GlobalDropZone.tsx` (a page-wide drag-and-drop overlay, entirely separate from the inbox page's button) does track duplicates:

```tsx
const duplicate = results.filter(r => r.ok && r.duplicate).length
...
setState({ phase: 'done', uploaded, duplicate, failed })
```

and renders (`GlobalDropZone.tsx:116-120`):

```tsx
<p className="text-lg font-semibold text-zinc-100">
  {uploaded} uploaded
  {duplicate > 0 ? `, ${duplicate} duplicate` : ''}
  {failed > 0 ? `, ${failed} failed` : ''}
</p>
```

Two separate gaps stack here:
1. This overlay only fires on the global `dragenter`/`drop` document listeners — it is never involved in the button-upload flow the test (and `ImageUpload.viaButton`) actually exercises.
2. Even on the drag-and-drop path, the rendered text is `", 1 duplicate"` — never the literal string `"Image already uploaded"`. A repo-wide search confirms that exact phrase does not exist anywhere in `system/dashboard/src`.

So today, no code path in the dashboard — button or drag-and-drop — ever shows the words "Image already uploaded". The transient (`setTimeout(reset, 3000)`, `GlobalDropZone.tsx:68`) drag-and-drop toast is the closest existing behavior, and it's both differently worded and on the wrong upload path for what this spec checks.

---

## Steps to Reproduce

1. Upload `tests/fixtures/test-images/master.jpg` once via `/gm/inbox`'s "Upload" button; confirm it lands in `00-Inbox/images/`.
2. Upload the exact same file again via the same button.
3. Watch the network tab / server log: `upload-image: rejected duplicate master.jpg - identical to ...` fires correctly, response has `duplicate: true`.
4. Observe the dashboard UI: no warning of any kind appears. `setUploading(false)` fires and the page just silently doesn't add a new item.

---

## Proposed Solution

Product decision for the Nexus maintainer (two independent gaps, either can be fixed alone):

1. **Wire user feedback into the button-upload path.** `handleFilesSelected` (`page.tsx:84-94`) already has `result.duplicate` in hand — surface it (a toast, an inline banner, or reuse whatever pattern `GlobalDropZone` already has) instead of silently dropping it. This is the path this test — and presumably real users clicking "Upload" — actually use.
2. **Decide on the actual wording and pin it.** Whatever text is chosen ("Image already uploaded", "N duplicate(s) skipped", etc.), it should exist verbatim somewhere the test can assert on, and both upload entry points (button and drag-and-drop) should show the same message for the same condition rather than one being silent and the other showing different wording.

Until one of these lands, recommend updating the spec's expectation to match current (no-warning) behavior for the button path, or switching the spec to drive the drag-and-drop path and asserting on the text that's actually rendered there (`", N duplicate"`) — whichever the maintainer intends as the long-term contract.
