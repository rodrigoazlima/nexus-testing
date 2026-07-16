# QA Feedback: `body-dragon-air` token shows background scenery, not the dragon

**Reported by:** manual dashboard inspection (`http://localhost:48080/gm/view/eb857938-7f9f-4d3b-8a64-2ecb446b3444`)
**Symptom:** The generated VTT token for `body-dragon-air` (source `dragon-air.body.jpg`) is a crop of mountain/waterfall background — no dragon visible at all. Face detection did not find a face on this dragon-body artwork, so the token worker's upper-center fallback crop should have been used, but the crop actually baked into the PNG does not match what that fallback math produces against the current source image.

This document only records current data — no code was changed while producing it.

---

## Item identity

| Field | Value |
|---|---|
| Note UUID | `eb857938-7f9f-4d3b-8a64-2ecb446b3444` |
| Vault note | `.knowledge-base/01-Processing/body-dragon-air.md` |
| Source image | `.knowledge-base/00-Inbox/images/dragon-air.body.jpg` (736×1104 px) |
| Source sha (blake2b, field misleadingly named `sha256`) | `bc33c817dace15ac46957705b51147fa0ebdcd487f2caf0373823b9c9444f376` |
| Token output | `.knowledge-base/00-Inbox/images/dragon-air.body-token.png` (512×512 px) |
| type / creature_type / element / environment | body / dragon / air / mountain |

## Current token config (`system/state/workers/token/10-generate-tokens.json`, global, no per-item override)

```json
{
  "size": 512,
  "padding": 0.18,
  "forehead_ratio": 0.35,
  "body_ratio": 0.3,
  "focus_head": [0, 0, 0, 0],
  "moldura_path": ".knowledge-base/05-Assets/tokens/frames/frame.png",
  "moldura_by_type": {}
}
```

`moldura_by_type` is empty — this item gets the default frame, no creature-specific override exists.

## Vision state for this image (`agents/vision/state/processed-images.json`)

```json
{
  "uuid": "e3a11b45-b6c9-4ff9-804c-3a8bb7f87c8c",
  "processedAt": "2026-07-15T22:32:57.468826+00:00",
  "type": "body",
  "creature_type": "dragon",
  "element": "air",
  "environment": "mountain",
  "isToken": false,
  "status": "ok"
}
```

No `face` key present — `_store_face()` (`nexus/workers/token.py:99-119`) is a no-op when `_detect_face_mtcnn` / `_detect_face_opencv` both return `None`, so this confirms **no face was detected** on the current vision pass. Note this `processedAt` (22:32:57) is *later* than the token file's own mtime (below) — the image was reclassified by vision after the token already existed.

## Token generation record (`system/state/workers/token/generated-tokens.json`)

```json
"bc33c817dace15ac46957705b51147fa0ebdcd487f2caf0373823b9c9444f376": {
  "sourcePath": ".knowledge-base/00-Inbox/images/dragon-air.body.jpg",
  "tokenPath": ".knowledge-base/00-Inbox/images/dragon-air.body-token.png",
  "generatedAt": "2026-07-15T22:38:08.215638+00:00"
}
```

**But the token PNG's actual filesystem mtime is `2026-07-15T21:03:28.611Z`** — over 90 minutes *before* the recorded `generatedAt`. Source jpg mtime is `2026-07-08T22:38:37.805Z` (unchanged, not replaced since).

This gap is explained by `token.py:548-551` (`handle()`, `generate` action):

```python
if out_path.exists():
    ok, face = True, None
    log.info(f"Token already exists: {out_path.name}")
else:
    ok, face = _make_token(img_path, out_path, self._cfg, log, moldura_path=moldura_path)
```

When the PNG already exists, `_make_token` (the actual crop/composite step) is **skipped entirely** — but the code unconditionally falls through to rewrite `generated-tokens.json` with `"generatedAt": datetime.now(...)` regardless of whether generation actually ran. So the JSON timestamp is not trustworthy evidence of when the pixels were produced; the file mtime is.

## Fallback crop math, computed against the *current* source (736×1104, no face)

`_upper_center_crop()` (`nexus/workers/token.py:235-240`):
```
size = int(min(736, 1104) * 0.72) = 529
x    = (736 - 529) // 2           = 103
y    = int(1104 * 0.05)           = 55
```
→ crop region `x:[103,632] y:[55,584]`.

To sanity-check this math against the actual artwork, this region was manually extracted with `sharp` (not through the app) and saved to `docs/dev-feedback/dragon-air-crop-check.png` for reference — it shows the dragon's head/shoulders correctly, centered and cropped sensibly.

**This means the current fallback formula, applied to the current source image, produces the right answer.** The bad token on disk does not match what this formula outputs, which points at the *existing* PNG being a leftover from a prior run (different config, different detected/false-positive face, or a different revision of the fixture) that was never invalidated when vision reclassified the image at 22:32:57.

## Open questions (not investigated further per instruction)

- What crop/face state actually produced the checked-in bad PNG at 21:03:28 — no per-generation log or face record survived (current `processed-images.json` entry postdates it and carries no `face` field).
- Whether `handle()`'s skip-if-exists path should also skip rewriting `generated-tokens.json`'s `generatedAt`, or whether staleness here should instead invalidate the file when the source's vision-classification changes.

---

## Update: manual fix applied via dashboard token editor

User manually re-cropped the token in the dashboard's token editor (`Edit` / `/gm/view/<uuid>/token`) and saved. New state captured below — **no automated code was touched, this is the manual-edit result only.**

| Field | Value |
|---|---|
| Token PNG mtime | `2026-07-15T22:54:04.641Z` (was `21:03:28.611Z`) |
| Visual result | Correct — dragon head/face (eye, horns, jaw) now centered in the circular token, confirmed by direct image read |

New crop, visually estimated against the 736×1104 source: head framed roughly `x:[40,560] y:[40,560]` (square, upper-left-of-center on the source — the dragon's head sits left-of-center at the top, not dead-center as the old `_upper_center_crop` fallback assumed).

### The save did not update the canonical index the worker reads

`system/state/workers/token/generated-tokens.json` (the file `nexus/workers/token.py` actually reads/writes, `_GEN_TOKENS`) still shows the stale record, unchanged by the manual save:
```json
"generatedAt": "2026-07-15T22:38:08.215638+00:00"
```
Reason: the dashboard's save route (`system/dashboard/src/app/api/gm/token/save/route.ts:64`) writes its index update to `agents/token/state/generated-tokens.json` — a **different, legacy path** than `token.py`'s `_GEN_TOKENS` (`system/state/workers/token/generated-tokens.json`). That legacy path doesn't currently exist on disk at all in this install, so the manual edit's index write target is unclear/unverified; only the PNG bytes themselves are confirmed updated. Recorded here as data, not fixed.

### Vision state, for reference (unchanged by the manual token edit — token editing doesn't touch vision state)

```json
{
  "uuid": "e3a11b45-b6c9-4ff9-804c-3a8bb7f87c8c",
  "path": ".knowledge-base/00-Inbox/images/dragon-air.body-01.jpg",
  "processedAt": "2026-07-15T22:44:58.135157+00:00",
  "sha256": "bc33c817dace15ac46957705b51147fa0ebdcd487f2caf0373823b9c9444f376",
  "isToken": false,
  "status": "ok"
}
```
Same sha as before; `path`/`originalName` now show `dragon-air.body-01.jpg` (renamed since the last check) and `processedAt` advanced to `22:44:58` — a reclassification happened between the original bad token and this manual fix, unrelated to the token editor itself. Still no `face` key — the manual editor does not write detected/selected face coordinates back to vision state, so there is no reusable face-selection record for future automated regeneration to pick up; the fix lives only in the flattened output PNG.

---

## QA recommendations for the Nexus maintainer (dragon/creature token pipeline)

Ranked by how directly each one would have prevented this specific bug from reaching the dashboard undetected.

### 1. (Highest priority) `handle()`'s skip-if-exists path lies about `generatedAt`

`nexus/workers/token.py:548-564` — when `out_path.exists()`, `_make_token` never runs, yet `generated-tokens.json` is unconditionally rewritten with `datetime.now(timezone.utc)`. This is the reason the bad token's real production time (file mtime `21:03:28`) was invisible behind a fresher, misleading `generatedAt` (`22:38:08`) — anyone auditing "when was this generated" from the index alone gets the wrong answer.

**Fix:** only write `generatedAt` on the branch that actually calls `_make_token`. If the skip branch needs its own bookkeeping (e.g. "last confirmed present at"), give it a separate field name (`lastVerifiedAt`) instead of overloading `generatedAt`.

### 2. Two `generated-tokens.json` files answer "is this token current" differently

- Worker canonical: `system/state/workers/token/generated-tokens.json` (`token.py`'s `_GEN_TOKENS`).
- Dashboard manual-save target: `agents/token/state/generated-tokens.json` (`system/dashboard/src/app/api/gm/token/save/route.ts:64`) — a path `token.py` itself only treats as a one-time legacy migration source (`_LEGACY_STATE_DIRS`, `_adopt_legacy_state()`), not a live target.

A manual dashboard edit and the automated worker are silently writing to two different bookkeeping files. Today that "just" means the index goes stale after a manual fix (harmless-looking); tomorrow, if `_adopt_legacy_state()` ever re-runs against a populated legacy dir, a manual edit could be **overwritten by a re-adopted stale entry**.

**Fix:** point the dashboard save route at the same constant `token.py` uses (export `_GEN_TOKENS`'s path from one shared config module both the Python worker and the Next.js API route read, or at minimum hardcode the *same* literal path in both places) so there is exactly one source of truth for "what token exists and when."

### 3. Nothing invalidates a token when its source is reclassified

`TokenWorker.pending()` (`token.py:447-510`) treats `img_key in gen_tokens` as "done, forever" — it never re-checks whether the *current* vision classification (type/face) still matches what the token was generated from. This install shows vision reclassified `dragon-air.body.jpg` (`processedAt` moved from before `21:03:28` to `22:32:57`, later again to `22:44:58`) with the stale token never regenerated or flagged. A generated token has no link back to "which vision-state revision produced me."

**Fix:** store the source vision entry's `processedAt` (or its `sha256`/classification fingerprint) inside the `generated-tokens.json` entry itself, and have `pending()` treat a mismatch against the current vision entry as `action: "generate"` (stale) instead of leaving it untouched forever.

### 4. Manual dashboard fixes don't persist a reusable face/crop override

`token/save/route.ts` writes only the flattened output PNG — no crop rectangle, no face box, nothing back into `processed-images.json`'s `face` field. If issue #3 above ever gets fixed and the worker starts auto-regenerating stale tokens, it will happily **stomp this exact manual fix** back to the broken auto-detected/fallback crop, because there's no record that a human already corrected it.

**Fix:** have the token editor's save action also persist the crop rectangle (or an equivalent `face` override) alongside the PNG, and have `pending()`/`handle()` treat manually-edited entries as pinned (skip auto-regeneration) the same way a `paused` queue slot already is (`_set_queue_token_slot`, `token.py:144-164`) — that pause mechanism already exists for a different purpose and is the natural place to plug this in.

### 5. Face detection has no fallback strategy suited to non-human creature art

`_detect_face_mtcnn` / `_detect_face_opencv` (`token.py:194-232`) are both human-face detectors. For `type: body` + `creature_type: dragon` (or any non-humanoid creature), there usually **is no human face to find** — confirmed here (no `face` key on either the original or reclassified vision entry) — so every dragon/creature-body token silently falls through to `_upper_center_crop`, a generic "top 53%, centered" square that happens to work for a portrait-oriented dragon head shot but has no awareness of *where* the subject actually is in the frame (see the manually-fixed crop above: the correct head position was left-of-center, not centered, on this particular piece of art).

**Fix (product decision, flagging not prescribing):** for entries where `creature_type != "none"`, either (a) skip face-detection entirely and go straight to a creature-aware heuristic (e.g. weight the crop toward the upper third but let the classification agent's bounding-box-free description hint at left/right bias), or (b) accept that `_upper_center_crop` is a coarse default for this category and make the dashboard's manual token editor the expected correction step for creature bodies — in which case recommendations #3 and #4 above (persist + pin the manual fix) become mandatory, not optional, for this content type.

### 6. Minor: `sha256` field is not SHA-256

Carried over from the axe.jpg investigation (`docs/dev-feedback/01_tips_to_fix.stage-inbox-ingestion.spec.ts.md`) and reconfirmed here: `_sha256()` (`classify_images.py:90-95`) is `blake2b(digest_size=32)`. Harmless today since nothing hashes independently to compare, but worth a rename before any external tooling (this test repo included) tries to verify it with real SHA-256.
