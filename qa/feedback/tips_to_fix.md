# QA Feedback: axe.jpg tagged `#scene #interior` instead of axe/weapon tags

**Reported by:** QA (via `stage-inbox-ingestion.spec.ts:51`)
**Symptom:** Uploading `tests/fixtures/test-images/axe.jpg` (a battle-axe token image) resulted in the dashboard note `http://localhost:48080/gm/view/e5a41f28-2f75-4672-bfd9-02f02bcf3310` showing `type: scene`, `tags: [#scene, #interior]`. Expected tags to reflect an axe/weapon image.

This document only analyzes — no code was changed while producing it.

---

## Root Cause

Two independent issues stack up here. Fixing only one will not fully resolve the symptom.

### 1. (Primary) The note being inspected is not axe.jpg's note — test-harness bug, not a Nexus defect

`e5a41f28-…` is visually confirmed (screenshot) to render the axe artwork, but its frontmatter (`slug: scene-interior-01`, `source: .../scene-interior-01.jpg`) belongs to a *different* dropped image. A second wrong match was also observed at `f66cc82a-…` with tags `["token","elf","humanoid","interior"]` — consistent with `tests/image-tags/elf-ranger.spec.ts`, which runs concurrently with the axe test under Playwright's `workers: 3` (`playwright.config.ts`).

The matching function `waitForSlugNote` (`tests/helpers/vault-utils.ts:90-161`) resolves "which note belongs to my dropped file" like this:

```
renamedCandidates = every new file that appeared anywhere in 00-Inbox/images since this spec's beforeAll baseline, minus originalRandomName
newNotes          = every new .md file that appeared anywhere in 01-Processing since this spec's beforeAll baseline
match             = first newNotes entry whose `source:` field string-matches ANY renamedCandidates entry
```

Nothing in this algorithm scopes `renamedCandidates` or `newNotes` to *this test's own* dropped file. Per `CLAUDE.md`'s documented concurrency model: *"All specs share one real vault with no per-run isolation... `waitForSlugNote`'s baseline-diff can theoretically cross-match another spec's renamed file if two drops land close together — an accepted risk."* This run is a live instance of that accepted risk actually firing, not a hypothetical.

Net effect: the axe.jpg test asserted against a note that vision/classification never produced from axe.jpg's bytes at all.

### 2. (Secondary, independent of #1) The vision schema has no vocabulary slot that could ever produce "axe" or "weapon" as a tag

Read `agents/vision/tools/classify_images.py:650-668` (`_write_draft`) and `system/src/nexus/shared/models.py:48-134`:

```python
tags: list[str] = [clf.type.value]                       # ImageType: portrait/body/battlemap/scene/token
if clf.ancestry != "none":       tags.append(clf.ancestry)        # PF2E_ANCESTRIES (human, elf, dwarf, ...)
if clf.creature_type != "none":  tags.append(clf.creature_type)   # PF2E_CREATURE_TYPES (dragon, undead, ...)
if clf.element.value != "none":  tags.append(clf.element.value)   # Element (fire, water, ...)
if clf.environment.value != "none": tags.append(clf.environment.value)  # Environment (dungeon, tavern, ...)
```

`ImageType`, `PF2E_ANCESTRIES`, `PF2E_CREATURE_TYPES`, `Element`, and `Environment` are the **entire** tag vocabulary the classifier can emit. None of these enums contain anything item/weapon-shaped ("axe", "weapon", "item", "artifact" do not exist anywhere in `models.py`). The closest `ImageType` value for a standalone weapon-on-plain-background image is `token`, but nothing downstream of that can describe *what kind* of token it is.

So even after fixing #1 and correctly matching axe.jpg's real note, the best-case tags today would be `["token"]` (plus possibly a stray `environment`/`element` guess the LLM hallucinates onto an object with no environment) — never `"axe"` or `"weapon"`. `EXPECTED_TAGS = ['token', 'axe', 'weapon']` in `stage-inbox-ingestion.spec.ts:21` is flagged in its own comment as `ponytail: filename-guessed, not verified ground truth` — this investigation confirms it's not just unverified, it's currently *unachievable* by the schema as written.

---

## Steps to Reproduce

1. Ensure LM Studio is serving on `http://localhost:1234` with the configured vision model (`qwen3-vl-4b-instruct` by default) and the Nexus daemon/service is running against a vault at `VAULT_PATH`.
2. Run the full suite (or just `tests/pipeline/stage-inbox-ingestion.spec.ts`) with `workers: 3` so multiple spec files execute concurrently — critically, run it alongside at least one other spec that drops a `scene`/`interior`-type or `elf`/`humanoid`-type fixture around the same time (e.g. `tests/image-tags/elf-ranger.spec.ts`), since single-spec isolated runs are much less likely to race.
3. In `stage-inbox-ingestion.spec.ts`, the messy-named copy of `axe.jpg` is dropped into `00-Inbox/images/` (`stage-inbox-ingestion.spec.ts:56-61`).
4. `waitForSlugNote` polls until *some* new note in `01-Processing/` references *some* new image in the inbox (`vault-utils.ts:104-141`) — under concurrent drops, it can match a sibling spec's note instead of axe.jpg's own.
5. Open the resolved note's UUID in the dashboard (`/gm/view/<uuid>`) and compare the rendered image (axe artwork) against the frontmatter `type`/`tags`/`source` — they belong to a different drop.
6. Independently: manually classify `axe.jpg` once matching is fixed and confirm actual tags are at best `["token"]` with no way to reach `"axe"`/`"weapon"` given today's `VisionClassification` schema.

---

## Proposed Solution

### For issue #1 — test harness (`tests/helpers/vault-utils.ts`), no Nexus code change needed
Anchor the match to the *specific* file this test dropped instead of "any new file / any new note":
- Capture the dropped file's NTFS file ID (`fs.stat().ino`) immediately after copying it into the inbox, before the daemon can touch it (same-volume renames preserve file ID on NTFS, and both ingestion's emoji-strip and vision's slug-rename are same-directory `Path.rename()` calls — confirmed in `ingestion.py:161-174` and `classify_images.py:345-383`).
- When scanning candidate notes in `waitForSlugNote`, additionally `fs.stat()` each candidate image and require its `ino` match the captured original before accepting it as a match; skip (don't return) on mismatch instead of taking the first filename-based hit.
- This requires no signature change — `waitForSlugNote` already resolves `originalRandomName`'s full path internally, so all ~30 existing call sites are fixed automatically.
- Content-hash matching (sha256/blake2b of file bytes) was considered and rejected as the primary key: Nexus's frontmatter field is misleadingly named — `_sha256()` (`classify_images.py:90-95`) is actually `blake2b(digest_size=32)`, not SHA-256, so a JS-side `crypto.createHash('sha256')` would silently never match. `ino` avoids reimplementing a non-standard hash algorithm entirely.

### For issue #2 — vision schema/prompt (`agents/vision`), a Nexus codebase change, out of scope for the test repo
Two independent options, either resolves the schema gap:
- **(a) Correct the test expectation** instead of the schema: change `EXPECTED_TAGS` in `stage-inbox-ingestion.spec.ts:21` to what the current schema can actually produce for a weapon image (likely just `['token']`, verified against a real classification run once issue #1 is fixed) — lowest-risk, no product behavior change.
- **(b) Extend the vision schema** if item/weapon images are meant to be a first-class category: add an item/weapon dimension to `VisionClassification` (`shared/models.py`) and its prompt (`agents/vision/prompts/classify-image.txt`), keeping both in sync per this agent's own `CLAUDE.md` note ("kept in sync with `shared/models.py` `PF2E_*` constants — update both together"). This is a product decision (does Nexus intend to classify item art at all?), not a bug fix — flag to the Nexus maintainer before doing this.

Recommend (a) now to unblock the test suite, and raising (b) as a separate product question rather than bundling it into this fix.
