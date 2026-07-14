# nexus-image-pipeline-tests

Black-box Playwright tests for the Nexus Campaigns image ingestion pipeline: dropping/uploading an image into the vault's `00-Inbox/images`, waiting for the real vision-agent daemon to rename it and write an enriched draft note into `01-Processing`, and checking both the vault filesystem and the dashboard UI reflect that result.

These tests exercise the **real** daemon (out of scope, lives at `NEXUS_PATH`) and a **real** vault (`VAULT_PATH`). No mocks, no fixtures/teardown isolation between runs.

## Setup

```
npm install
cp .env.example .env   # then edit as needed
```

**Run from an elevated shell.** `npm test`/`npm run clean` shell out to `setup-service.ps1`, which installs a Windows service — without admin rights it fails deep inside the script with an error that doesn't mention elevation. `clearInstall`/`installFresh` (`tests/helpers/nexus-install.ts`) now check up front and throw a clear "re-run as Administrator" error instead.

Env vars (see `tests/helpers/config.ts`):

| Var | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./.testing/vault` | root of the Obsidian vault under test |
| `DASHBOARD_URL` | `http://localhost:48080` | dashboard base URL (Playwright `baseURL`) |
| `POLL_TIMEOUT_MS` | `10 * 60_000` (10 min) | how long to poll the vault for the daemon's output |
| `POLL_INTERVAL_MS` | `5_000` | poll interval while waiting |
| `TEST_TIMEOUT_MS` | `10 * 60_000` (10 min) | Playwright per-test timeout |
| `NEXUS_PATH` | `./.testing/nexus` | Nexus codebase/service install used by `tests/global-setup.ts` / `tests/global-teardown.ts` (not read by the specs themselves). Must be NTFS — `setup-service.ps1` links agents via junctions, unsupported on exFAT. |
| `NEXUS_BRANCH` | `master` | git branch/ref of `NexusCampaigns` that `installFresh()` clones into `NEXUS_PATH` (`tests/helpers/nexus-install.ts`). Set this to test against a feature branch instead of `master`. |

## Running against a specific Nexus branch

By default `installFresh()` clones `NexusCampaigns`'s `master` branch. To run the suite against a different branch (e.g. an in-progress agent change), set `NEXUS_BRANCH` in `.env` before `npm test`:

```
# .env
NEXUS_BRANCH=my-feature-branch
```

`npm test` (and `test:pipeline:fast`/`test:pipeline:slow`) run through Playwright, which loads `.env` automatically before `global-setup.ts` calls `installFresh()` — the branch is passed straight to `git clone --branch <NEXUS_BRANCH> ...`, so a non-existent branch/ref fails the clone immediately with git's own error.

`NEXUS_BRANCH` only matters for the clone step (`installFresh`), not `clearInstall`/`npm run clean` — those just uninstall/remove whatever is already at `NEXUS_PATH` regardless of which branch it came from. Also note `npm run clean` (`scripts/clean.ts`) runs via `tsx`, not Playwright, so it does **not** auto-load `.env`; export `NEXUS_BRANCH` (and any other vars you need it to see) in the shell if you're invoking it directly rather than through `npm test`.

## Running

```
npm test          # global setup (fresh install) -> full suite -> global teardown (uninstall)
npm run test:unit # fast unit tests for setup-service.ps1's argument construction (no real install)
npm run report    # open the last HTML report
```

`npm run test:unit` runs `tests/helpers/nexus-install.test.ts` on Node's built-in test runner (via `tsx`, not Playwright — `.test.ts` is deliberately a different suffix from `.spec.ts` so Playwright's `testMatch` never picks it up). It mocks `execFileSync` to assert the exact `git`/`setup-service.ps1` arguments and stdin `clearInstall`/`installFresh` send — including the elevation check and the `.env.local` sanity check — without cloning, installing a service, or requiring an elevated shell.

`npm test` drives the full lifecycle through Playwright's own `globalSetup`/`globalTeardown` hooks (wired in `playwright.config.ts`), both plain TypeScript:

1. **`tests/global-setup.ts`** — clears any dirty/leftover install (uninstalls the service if present, removes `NEXUS_PATH`), clones `NexusCampaigns` fresh, then runs `setup-service.ps1 -CleanInstall`. Same steps as `custom-install.ps1`, kept as our own TS copy rather than invoking that script directly. `setup-service.ps1` itself is the target repo's own installer, so it's still shelled out to as a subprocess. Afterwards, warns (doesn't fail the run) if no `.env.local` file exists anywhere under `NEXUS_PATH` — `-CleanInstall` wipes them and nothing recreates them, a suspected cause of silent vision-agent failures (see `performance-review-notes.md`).
2. **the spec suite** — runs in full, against the freshly installed dashboard/daemon and `VAULT_PATH`.
3. **`tests/global-teardown.ts`** — uninstalls the service and wipes `NEXUS_PATH`/`VAULT_PATH` (same steps as `scripts/clean.ts`), leaving `.testing` clean for the next run.

Global setup/teardown run on every `playwright test` invocation (including filtered runs, e.g. `npx playwright test image-processing`).

```
npm run clean     # wipe NEXUS_PATH (service uninstall + dir) and VAULT_PATH
```

`scripts/clean.ts` does not run automatically — use it to reset the machine by hand between manual runs.

`clearInstall`/`installFresh` (global-setup, global-teardown, `clean.ts`) all take a lock file at `.testing/.install.lock` — whichever runs first wins, the other two throw immediately instead of racing the same install dir. Stale lock (killed process) → delete the file by hand.

## Tests

- **`tests/image-processing.spec.ts`** — full pipeline: copies `fixtures/test-images/sword-test.jpg` into `00-Inbox/images` under a random name, polls (no way to force-trigger the daemon — a 60s runtime loop feeding a 900s vision-agent interval) until it's renamed and a draft note appears in `01-Processing`, then asserts frontmatter invariants, body sections, and that the dashboard's note view matches. Slow — a live backlog can push this out 50+ minutes.
- **`tests/inbox-upload.spec.ts`** — fast, UI-only: proves the two `/gm/inbox` upload entry points (Upload button, drag-and-drop) land the file in `00-Inbox/images` and show up in the inbox listing. Does **not** wait for the vision daemon — the full round-trip is already covered once by `image-processing.spec.ts`.
- **`tests/bestiary-classification.spec.ts`** — second-stage pipeline: after the vision draft lands, polls the *same* note for the classification-agent (LocalRouter `localhost:8080`) to enrich tags/type, then asserts a specific tag set + bestiary `type`, and that the entity shows on `/gm/bestiary`. Reference/template for scenario tests — see below.

## Helpers

- `tests/helpers/config.ts` — env-driven paths/timeouts.
- `tests/helpers/vault-utils.ts` — directory snapshotting/diffing, frontmatter parsing (`gray-matter`), `waitForSlugNote` (polls for the daemon's renamed image + draft note), `pollNoteUntil` (re-polls one known note for a second-stage agent's enrichment), `assertDraftInvariants` (structural checks only — never asserts on LLM-generated prose), `copyForInspection` (saves a failing run's files to `tmp/` before cleanup deletes them), `copyNexusDiagnostics` (saves `NEXUS_PATH`'s `automation.log` + `system/state/*.json` into the same `tmp/` dir — the only way to see what the daemon was doing, since `global-teardown.ts` wipes `NEXUS_PATH` right after the run), cleanup of files created during a run.
- `tests/helpers/dashboard-ui.ts` — dashboard page interactions: open a note by UUID, assert note view matches frontmatter, upload via button, upload via drag-and-drop.

## Adding a new image/scenario test

Follow `tests/bestiary-classification.spec.ts` as the template. Structure:

1. Add the fixture image to `tests/fixtures/test-images/`.
2. `test.describe.serial(...)` with a `createdPaths: string[]`, baselines snapshotted in `beforeAll` via `snapshotDir(INBOX_IMAGES_DIR)` / `snapshotDir(PROCESSING_DIR)`.
3. Step 1 — drop the fixture: `copyFixtureWithRandomName('your-image.jpg')`, push `destPath` onto `createdPaths`.
4. Step 2 — wait for the vision draft: `waitForSlugNote(randomName, inboxBaseline, processingBaseline)`, push `notePath`/`imagePath`, then `assertDraftInvariants(data, noteId)` for the structural checks every draft must pass.
5. Step 3 (if your scenario needs second-stage enrichment — tags beyond the image category, or a refined `type`) — `pollNoteUntil(notePath, predicate, describe, { timeout })`. Give it a real ceiling below the 10min test timeout (3min is the going rate) so a stuck/offline agent fails fast with a readable message instead of eating the whole budget silently.
6. Assert your scenario's expectations: exact tags via `toContain`, `type` against the relevant vocab (e.g. `BESTIARY_TYPES`), dashboard visibility via `page.goto('/gm/<pillar>')` + `page.getByText(noteId)`.
7. `test.afterEach(async ({}, testInfo) => { if (testInfo.status !== testInfo.expectedStatus) { const dir = await copyForInspection(createdPaths, testInfo.title); await copyNexusDiagnostics(dir); } })` — copies whatever the run created, plus `NEXUS_PATH`'s daemon log/state JSON, into `tmp/<timestamp>_<test-title>/` for manual review *before* `afterAll`/global teardown deletes the originals. Always add this for a new scenario test; a failed classification/tagging assertion (or a timeout) is exactly the case you want the artifacts for.
8. `afterAll` → `cleanupCreatedFiles(createdPaths)`, unconditional, same as the existing specs.

## Notes / gotchas

- 3 workers, `fullyParallel: false` — spec *files* run in parallel, tests *within* a file stay in written order (`describe.serial`). Accepted risk: concurrent specs share one real vault, so `waitForSlugNote`'s baseline-diff can in theory cross-match another spec's renamed file if two drops land close together. No retries.
- `afterAll` hooks delete only the specific files a run created (`cleanupCreatedFiles`) — never folders, to avoid OneDrive Cloud-Files placeholder issues.
- `expect.timeout` is 15s by default (fails fast on a bad selector); only the long polls (`waitForSlugNote`, `pollNoteUntil`) get the extended budget explicitly.
- Classification-agent enrichment depends on LocalRouter (`localhost:8080`) being up — if it's offline the agent logs a WARN and skips, and a `pollNoteUntil` waiting on tags/type will time out. That's a real signal, not flakiness — check `nexus/agents/runtime/state/logs/automation.log` for `LocalRouter offline`.
