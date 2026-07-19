# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Black-box Playwright tests for the **Nexus Campaigns** image ingestion pipeline. Tests drop/upload an image into a real Obsidian vault's `00-Inbox/images`, wait for the real Nexus daemon (a separate codebase, cloned fresh per run into `NEXUS_PATH`) to process it through multiple agent stages, and assert on the resulting vault filesystem state and dashboard UI. **No mocks** — the daemon, vault, and dashboard under test are all real.

## Commands

```
npm install
cp .env.example .env          # then edit as needed

npm test                      # global-setup (fresh install) -> full suite (excludes @slow-agent) -> global-teardown (uninstall)
npm run test:keep             # retain NEXUS_PATH + VAULT_PATH for inspection
npm run test:only -- <specs>  # global-setup -> named specs + required cleanup spec (stage-inbox-exclusion) -> global-teardown; add --keep to retain artifacts and skip the cleanup spec
npm run test:pipeline:fast    # tests/pipeline only, excludes @slow-agent
npm run test:pipeline:slow    # tests/pipeline only, @slow-agent tests only
npm run test:unit             # fast unit tests (Node's test runner via tsx, not Playwright) for setup-service.ps1 arg construction — no real install
npm run report                # open last HTML report
npm run clean                 # wipe NEXUS_PATH (service uninstall + dir) and VAULT_PATH by hand
npm run lint                  # eslint .
```

Run a single spec: `npx playwright test tests/pipeline/stage-inbox-ingestion.spec.ts` (global setup/teardown still run — there's no way to skip them). Run a single unit test file: `node --import tsx --test tests/helpers/nexus-install.test.ts`.

**Must run from an elevated (Administrator) PowerShell.** `npm test`/`npm run clean` shell out to the target repo's own `setup-service.ps1` to install/uninstall a Windows service. `clearInstall`/`installFresh` (`tests/helpers/nexus-install.ts`) check elevation up front (`assertElevated`) and throw a clear error instead of letting the `.ps1` fail cryptically deep inside.

## Environment variables (`tests/helpers/config.ts`, `tests/helpers/nexus-install.ts`)

| Var | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./.testing/vault` | root of the Obsidian vault under test |
| `NEXUS_PATH` | `./.testing/nexus` | Nexus codebase/service install, set up by `global-setup.ts` / torn down by `global-teardown.ts`. Must be NTFS (junctions used for agent linking). |
| `NEXUS_BRANCH` | `master` | git branch/ref of NexusCampaigns to clone into `NEXUS_PATH` |
| `NEXUS_REPO_URL` | upstream NexusCampaigns repo | git URL cloned into `NEXUS_PATH` — override to point at a fork |
| `DASHBOARD_URL` | `http://localhost:48080` | dashboard base URL (Playwright `baseURL`) |
| `POLL_TIMEOUT_MS` | 10 min | how long to poll the vault/state files for daemon output |
| `POLL_INTERVAL_MS` | 5 s | poll interval |
| `TEST_TIMEOUT_MS` | 10 min | Playwright per-test timeout |

Timeouts were cut from ~90 min on 2026-07-09 to fail fast — see `performance-review-notes.md`. `expect.timeout` (Playwright default matcher timeout) is 15s; only the two poll helpers get the long budget explicitly via an explicit per-call `timeout`.

Every other exported path/constant across `tests/helpers/*.ts` (vault subfolder paths, daemon state-file paths, `SETUP_SCRIPT`/`REGISTRY_PATH`, agent interval overrides, `IMAGE_CATEGORY_VOCAB`/`BESTIARY_TYPES`, profiling output paths) is also env-overridable, falling back to its derived default when unset — see the "Advanced overrides" block in `.env.example` for the full list and each one's default.

## Architecture

### Lifecycle: this repo owns the Nexus install, not just the tests

`tests/global-setup.ts` and `tests/global-teardown.ts` are wired into `playwright.config.ts` and run on **every** `playwright test` invocation, including filtered/single-spec runs:

1. **global-setup**: `clearInstall()` (uninstall service if present, `rmSync` the install dir) → `installFresh()` (git clone Nexus, run `setup-service.ps1 -CleanInstall -VaultRoot VAULT_PATH`) → `warnIfEnvLocalMissing()` (non-fatal warning; `-CleanInstall` wipes every `.env.local` under `NEXUS_PATH` and nothing recreates them — suspected cause of silent vision-agent auth failures).
2. **the spec suite** runs against the freshly installed dashboard/daemon/vault.
3. **global-teardown**: uninstalls the service, wipes `NEXUS_PATH` and `VAULT_PATH`.

`scripts/clean.ts` (`npm run clean`) runs the same clear/wipe steps by hand, outside the test lifecycle. All three entry points (`global-setup`, `global-teardown`, `clean.ts`) serialize on a lock file at `.testing/.install.lock` via `withInstallLock` — concurrent callers throw immediately rather than queuing. A stale lock (from a killed process) must be deleted by hand.

Because the pipeline can't be force-triggered (the daemon lives out-of-scope at a separate path — see AGENTS.md hard rules), specs poll real wall-clock intervals (60s runtime loop, 90s vision-agent interval — test-lane override, see `AGENT_INTERVAL_VISION_S` in `nexus-install.ts`) — this is why the suite is slow and why timeouts matter.

### Test layout

- **`tests/pipeline/`** — one spec per pipeline stage or agent (`stage-*.spec.ts`, `agent-*.spec.ts`), plus the two original whole-pipeline specs (`image-processing.spec.ts`, `inbox-upload.spec.ts`). Stages/agents map roughly 1:1 to the vault's folder structure (`00-Inbox` → ingestion/vision → `01-Processing` → classification/lore/thumbnail/wikilink/etc. → human review → `02-Library` → `99-Archive`).
- **`tests/image-tags/`** — one spec per fixture image, asserting the vision agent's tag output for that specific image (`assertTagsInclude`). Tags beyond `tags[0]` (the category) are frequently filename-guessed, not verified ground truth — marked with `ponytail:` comments where the real value is still unconfirmed against a live daemon run.
- **`tests/scenario-rename-test.spec.ts`** — standalone scenario spec (not under `pipeline/` or `image-tags/`).
- Every spec follows the same shape: `test.describe.serial(...)` with a `createdPaths: string[]`, directory baselines snapshotted in `beforeAll` (`snapshotDir`), steps via `test.step(...)`, an `afterEach` that copies artifacts for inspection on failure, and an `afterAll` that hands `createdPaths` off to the centralized cleanup registry.

### Helpers (`tests/helpers/`)

- **`config.ts`** — env-driven paths/timeouts/vault subdirectory constants. Nothing else.
- **`nexus-install.ts`** — clone/install/uninstall Nexus, the install lock (`withInstallLock`), elevation check (`assertElevated`), and the `.env.local` sanity check (`warnIfEnvLocalMissing`).
- **`vault-utils.ts`** — the core polling/assertion toolkit:
  - `snapshotDir` / `diffNewFiles` — directory-diff baseline pattern used by every spec to detect new files without watching.
  - `waitForSlugNote` — polls until an original random-named dropped image disappears from the inbox (renamed by the daemon) *and* a new `01-Processing/*.md` draft's `source:` frontmatter references the renamed sibling. This is the primary "did the pipeline run" signal.
  - `assertDraftInvariants` — **structural checks only** (UUID format, sha256 format, status/quality/reviewed defaults, non-empty tags/source). Never asserts on LLM-generated prose (note body text, descriptions) — that's a hard rule, see AGENTS.md.
  - `assertTagsInclude` — superset assertion with explicit expected/actual logging.
  - `pollNoteUntil` — re-polls one already-located note for second-stage agent enrichment (e.g. classification adding tags/type after vision already wrote the draft). Give it a real ceiling below the full test timeout (3 min is the going rate) rather than inheriting the full budget.
  - `copyForInspection` / `copyNexusDiagnostics` — on failure, copies a run's files plus `NEXUS_PATH`'s `automation.log` and `system/state/*.json` into `tmp/<timestamp>_<label>/` *before* cleanup/teardown deletes the originals. Call both from `afterEach`, gated on `testInfo.status !== testInfo.expectedStatus`.
  - `registerCreatedPaths` / `drainCreatedPathsRegistry` — centralized cleanup: specs no longer delete their own files in `afterAll`. They append `createdPaths` to a shared on-disk ledger (`tmp/created-paths.jsonl`); only `tests/pipeline/stage-inbox-exclusion.spec.ts` actually drains and deletes, making "created files get cleaned up" itself a tested pipeline stage instead of implicit per-spec teardown.
- **`nexus-state.ts`** — direct access to the daemon's own JSON state files under `NEXUS_PATH` (`inbox-queue.json`, per-agent `processed-*.json`, `scenarios.json`, `wikilink-state.json`) for assertions `vault-utils.ts` can't make from vault files alone. `pollJsonState` mirrors `pollNoteUntil`'s shape for these files. `promoteToLibrary` / `archiveNote` simulate the human review step (agents are blocked from doing this themselves by `vault_guard.py` in the Nexus codebase) by writing approved frontmatter and moving notes between vault folders directly. `withScenarioActive` temporarily flips a scenario's `active` flag in shared daemon config, restoring the original in a `finally` (the file is live daemon config, not a test fixture). Several exact per-agent state file paths/schemas are marked `ponytail:` — inferred from doc conventions, not yet confirmed against a live run.
- **`dashboard-ui.ts`** — Playwright page interactions: open a note by UUID, assert note view matches frontmatter, upload via button, upload via drag-and-drop.

### Concurrency model

`playwright.config.ts`: `workers: 3`, `fullyParallel: false` — spec **files** run in parallel, tests **within** a file stay in written order (matches `describe.serial`). All specs share one real vault with no per-run isolation, so `waitForSlugNote`'s baseline-diff can theoretically cross-match another spec's renamed file if two drops land close together — an accepted risk, not a bug to fix by adding retries.

Three Playwright projects: `chromium` (everything else), `image-tags` (`tests/image-tags/`), and `token-after-image-tags` (`tests/token.spec.ts`, `dependencies: ['image-tags']`). `token.spec.ts` uploads nothing — it byte-matches the inbox images the image-tags specs already uploaded, so it must run strictly after that project. Dependency projects ignore CLI filters: `test:only tests/token.spec.ts` runs all image-tags specs first (intended); a filter matching neither project (e.g. `test:pipeline:*`) skips both.

Every upload funnels through `copyFixtureWithRandomName`, which rejects a second upload of the same fixture per run (ledger `tmp/uploaded-fixtures.jsonl`, cleared by global-setup) unless `{ allowDuplicate: true }` — only `tests/pipeline/image-duplication.spec.ts` passes that, to pin the system's own dedupe (second copy ignored + "Image already uploaded" warning). Dashboard uploads go through the `ImageUpload` class (`tests/helpers/image-upload.ts`: `drop` / `viaButton` / `viaDragAndDrop`). One fixture per spec — see `fixture-image-usage.md` for the current map.

`@slow-agent` tag marks tests gated on long daemon intervals (25–26min repair/cleanup cycles, or thumbnail/wikilink stacking their own 300s agent interval on top of vision's 90s pass); `npm test` and `test:pipeline:fast` exclude them, `test:pipeline:slow` runs only them. See `parallel-plan.md` for the current analysis of parallelizing the slow tests (bottleneck is the daemon's `pipeline_mode:sync` scheduler, not Playwright worker count).

## Hard rules (from AGENTS.md)

- Never mock the daemon, vault, or dashboard. If a step can't be verified live, say so — don't fake it.
- Never `rm -rf` a vault folder. Only delete files a test itself created, via the centralized registry (`registerCreatedPaths` → `stage-inbox-exclusion.spec.ts`). The vault is OneDrive-backed; folder deletes risk Cloud-Files placeholder corruption.
- Never touch `.testing/.install.lock` by hand except to clear a stale lock from a killed process.
- Never assert on LLM-generated prose (note body text, descriptions). Structural invariants only.
- Don't add a way to force-trigger the vision/classification/other agents — that's out of scope (the Nexus codebase itself). Tests wait out the real interval.
- Never delete approved Library content — archive it instead (`archiveNote` moves to `99-Archive`, doesn't delete).

## Adding a new pipeline/scenario/image-tag test

Copy the closest existing spec in `tests/pipeline/` or `tests/image-tags/` as a template. Order: drop fixture (`copyFixtureWithRandomName`, push onto `createdPaths`) → `waitForSlugNote` + `assertDraftInvariants` (+ `assertTagsInclude` if asserting tags) → optional `pollNoteUntil`/`pollJsonState` for second-stage enrichment with a real timeout ceiling, not the full test budget → scenario-specific assertions → dashboard visibility check if relevant (`page.goto('/gm/<pillar>')`) → `afterEach` copy-on-failure (`copyForInspection` + `copyNexusDiagnostics`) → `afterAll` → `registerCreatedPaths(createdPaths)` (not `cleanupCreatedFiles` directly — that's the centralized-cleanup spec's job now).

Add new fixture images to `tests/fixtures/test-images/`.
