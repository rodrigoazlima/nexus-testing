# Fixture image usage

Which spec uploads each image in `tests/fixtures/test-images/`. Updated 2026-07-15 after the duplicate-upload cleanup — regenerate by grepping `tests/` for fixture filename literals.

Every upload routes through `copyFixtureWithRandomName` (directly or via the `ImageUpload` class), which now **rejects a second upload of the same fixture per run** unless `{ allowDuplicate: true }` is passed (only `image-duplication.spec.ts` does, deliberately).

| Image | Used by | Notes |
|---|---|---|
| `axe.jpg` | `tests/pipeline/stage-inbox-ingestion.spec.ts`<br>`tests/helpers/vault-image-utils.test.ts` | Unit test reads bytes only (runs via `test:unit`, sandboxed ledger) — no vault drop conflict |
| `axe2.webp` | `tests/pipeline/inbox-upload.spec.ts` | drag-and-drop entry point (button test uses `sword-test.jpg`) |
| `bobby-barbarian.jpg` | `tests/pipeline/stage-library-promotion.spec.ts` | |
| `bow.jpg` | `tests/image-tags/bow.spec.ts` | also a name literal in the guard unit tests (no real drop) |
| `city-battlemap.jpg` | `tests/image-tags/city-battlemap.spec.ts` | |
| `diana-acrobat.jpg` | `tests/pipeline/agent-lore-npc-generation.spec.ts` | |
| `dragon-blue.jpg` | `tests/image-tags/dragon-blue.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `dragon-red-mountains.jpg` | `tests/image-tags/dragon-red-mountains.spec.ts` | |
| `dragon-red.jpg` | `tests/image-tags/dragon-red.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `dragon-white.jpg` | `tests/image-tags/dragon-white.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `eirc-cavalier.jpg` | `tests/image-tags/eirc-cavalier.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `elf-ranger.jpg` | `tests/image-tags/elf-ranger.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `elf-warrior.jpg` | `tests/pipeline/agent-classification-enrichment.spec.ts` | |
| `florest-cave.jpg` | `tests/pipeline/agent-thumbnail-generation.spec.ts` | |
| `half-orc.jpg` | `tests/pipeline/agent-review-report.spec.ts` | |
| `hank-ranger.jpg` | `tests/image-tags/hank-ranger.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `heman-barbarian1.jpg` | `tests/pipeline/agent-token-generation.spec.ts` | |
| `heman-barbarian2.jpg` | `tests/image-tags/heman-barbarian2.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `heman-barbarian3.jpg` | `tests/image-tags/heman-barbarian3.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `king-ragnor.webp` | — | unused |
| `master.jpg` | `tests/pipeline/image-duplication.spec.ts` | **uploaded twice on purpose** (`allowDuplicate: true`) — pins the system's dedupe behavior |
| `misty-mountains.jpg` | `tests/image-tags/misty-mountains.spec.ts` | |
| `orc1.jpg` | `tests/pipeline/agent-wikilink-related-links.spec.ts` | |
| `orc2.jpg` | `tests/pipeline/agent-wikilink-related-links.spec.ts` | |
| `Power_Sword.webp` | `tests/pipeline/stage-inbox-exclusion.spec.ts` | |
| `presto-magician.jpg` | `tests/pipeline/stage-archive.spec.ts` | |
| `ruins-florest.jpg` | — | unused |
| `She-ha.webp` | — | unused |
| `skeletor.jpg` | `tests/bestiary-classification.spec.ts` | |
| `sword-buster.webp` | `tests/pipeline/image-processing.spec.ts` | |
| `sword-test.jpg` | `tests/pipeline/inbox-upload.spec.ts` | Upload-button entry point only |
| `tree-florest.jpg` | — | unused |
| `two-characters-heman-and-she-ra.jpg` | `tests/image-tags/two-characters-heman-and-she-ra.spec.ts` | |
| `two-characters-skeletor-and-Hordakr.jpg` | `tests/image-tags/two-characters-skeletor-and-hordakr.spec.ts` | |
| `vingador.jpg` | `tests/image-tags/vingador.spec.ts` | token.spec.ts validates the upload, drops nothing |
| `waterfall-florest.jpg` | `tests/scenario-rename-test.spec.ts` | |

## Summary

- **Zero unintended duplicate uploads.** `token.spec.ts` no longer drops anything — it byte-matches the images its `image-tags/` specs uploaded (the `token-after-image-tags` Playwright project runs strictly after the `image-tags` project). `inbox-upload.spec.ts` uses a distinct fixture per entry point. `image-processing.spec.ts` moved to `sword-buster.webp`.
- **One deliberate duplicate**: `image-duplication.spec.ts` re-uploads `master.jpg` with `allowDuplicate: true` to assert the system ignores the copy and warns "Image already uploaded".
- **4 images unused**: `king-ragnor.webp`, `She-ha.webp`, `tree-florest.jpg`, `ruins-florest.jpg`.
- No fixture files are byte-identical to each other (sha256-checked 2026-07-15) — the guard keys on fixture filename because of this.
