<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">nexus-image-pipeline-tests</h3>

  <p align="center">
    Black-box Playwright tests for the Nexus Campaigns image ingestion pipeline —
    real daemon, real Obsidian vault, real dashboard. No mocks.
    <br />
    <a href="#usage"><strong>Explore the test catalog »</strong></a>
    <br />
    <br />
    <a href="https://github.com/rodrigoazlima/nexus-testing/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/rodrigoazlima/nexus-testing/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#environment-variables">Environment Variables</a></li>
        <li><a href="#running-against-a-specific-nexus-branch">Running Against a Specific Nexus Branch</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#commands">Commands</a></li>
        <li><a href="#test-lifecycle">Test Lifecycle</a></li>
        <li><a href="#test-catalog">Test Catalog</a></li>
        <li><a href="#helpers">Helpers</a></li>
        <li><a href="#adding-a-new-imagescenario-test">Adding a New Image/Scenario Test</a></li>
        <li><a href="#keeping-test-data-after-a-full-run">Keeping Test Data After a Full Run</a></li>
        <li><a href="#notes--gotchas">Notes / Gotchas</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

Black-box Playwright tests for the **Nexus Campaigns** image ingestion pipeline: dropping/uploading an image into the vault's `00-Inbox/images`, waiting for the real vision-agent daemon to rename it and write an enriched draft note into `01-Processing`, and checking both the vault filesystem and the dashboard UI reflect that result.

These tests exercise the **real** daemon (out of scope, lives at `NEXUS_PATH` — cloned fresh per run) and a **real** vault (`VAULT_PATH`). No mocks, no fixtures/teardown isolation between runs. Because the pipeline can't be force-triggered, specs poll real wall-clock agent intervals — this is why the suite is slow and why timeouts matter.

Pipeline stages map roughly 1:1 to the vault's folder structure:

```
00-Inbox → ingestion/vision → 01-Processing → classification/lore/thumbnail/wikilink/…
        → human review → 02-Library → 99-Archive
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Playwright][Playwright-badge]][Playwright-url]
* [![TypeScript][TypeScript-badge]][TypeScript-url]
* [![Node.js][Node-badge]][Node-url]
* [tsx](https://tsx.is/) — TS execution for scripts and Node's built-in test runner
* [gray-matter](https://github.com/jonschlinkert/gray-matter) — frontmatter parsing for vault note assertions
* [dotenv](https://github.com/motdotla/dotenv) — `.env` loading (must stay the *first* import, see below)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* **Windows** with an **elevated (Administrator) PowerShell**. `npm test`/`npm run clean` shell out to the target repo's `setup-service.ps1`, which installs a Windows service — without admin rights it fails deep inside the script with an error that doesn't mention elevation. `clearInstall`/`installFresh` (`tests/helpers/nexus-install.ts`) check up front and throw a clear "re-run as Administrator" error instead.
* **NTFS** volume for `NEXUS_PATH` — `setup-service.ps1` links agents via junctions, unsupported on exFAT.
* **Node.js** and npm.
* For vision/classification enrichment tests: the daemon's LLM backends must be up (classification uses LocalRouter on `localhost:8080`; if offline the agent logs a WARN and skips — see <a href="#notes--gotchas">Notes / Gotchas</a>).

### Installation

```sh
npm install
cp .env.example .env   # then edit as needed
```

`.env` is loaded via an `import 'dotenv/config'` at the top of `playwright.config.ts` (covers `npm test`, `test:pipeline:fast`, `test:pipeline:slow`) and `scripts/clean.ts` (covers `npm run clean`) — both must stay the *first* import in those files so it runs before any other module reads `process.env` at load time. `npm run test:unit` preloads `dotenv/config` too, so its mocked clone assertion uses the same `NEXUS_BRANCH`; the test itself replaces only `NEXUS_PATH`/`VAULT_PATH` with scratch directories before importing `nexus-install.ts`.

### Environment Variables

See `tests/helpers/config.ts`:

| Var | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./.testing/vault` | root of the Obsidian vault under test |
| `DASHBOARD_URL` | `http://localhost:48080` | dashboard base URL (Playwright `baseURL`) |
| `POLL_TIMEOUT_MS` | `10 * 60_000` (10 min) | how long to poll the vault for the daemon's output |
| `POLL_INTERVAL_MS` | `5_000` | poll interval while waiting |
| `TEST_TIMEOUT_MS` | `10 * 60_000` (10 min) | Playwright per-test timeout |
| `NEXUS_PATH` | `./.testing/nexus` | Nexus codebase/service install used by `tests/global-setup.ts` / `tests/global-teardown.ts` (not read by the specs themselves). Must be NTFS. |
| `NEXUS_BRANCH` | `master` | git branch/ref of `NexusCampaigns` that `installFresh()` clones into `NEXUS_PATH` (`tests/helpers/nexus-install.ts`). Set this to test against a feature branch instead of `master`. |
| `NEXUS_REPO_URL` | upstream NexusCampaigns repo | git URL cloned into `NEXUS_PATH` — override to point at a fork |

Every other exported path/constant across `tests/helpers/*.ts` (vault subfolder paths, daemon state-file paths, agent interval overrides, tag vocabularies, profiling output paths) is also env-overridable, falling back to its derived default when unset — see the "Advanced overrides" block in `.env.example` for the full list.

### Running Against a Specific Nexus Branch

By default `installFresh()` clones `NexusCampaigns`'s `master` branch. To run the suite against a different branch (e.g. an in-progress agent change), set `NEXUS_BRANCH` in `.env` before `npm test`:

```sh
# .env
NEXUS_BRANCH=my-feature-branch
```

`.env` is loaded via `dotenv` (see <a href="#installation">Installation</a>) before `global-setup.ts` calls `installFresh()` — the branch is passed straight to `git clone --branch <NEXUS_BRANCH> ...`, so a non-existent branch/ref fails the clone immediately with git's own error.

`NEXUS_BRANCH` only matters for the clone step (`installFresh`), not `clearInstall`/`npm run clean` — those just uninstall/remove whatever is already at `NEXUS_PATH` regardless of which branch it came from.

If a run still clones `master` after setting `NEXUS_BRANCH`, check (in order): the line is actually in `.env` (not just `.env.example`) at the repo root, spelled `NEXUS_BRANCH=`, with no `.env.local`/shell-exported `NEXUS_BRANCH` overriding it from elsewhere; and that `import 'dotenv/config'` is still the first import in `playwright.config.ts` — anything imported above it that reads `process.env` at module-load time (e.g. `tests/helpers/config.ts`, `tests/helpers/nexus-install.ts`) will otherwise capture the un-loaded value first.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

### Commands

```sh
npm test                      # global setup (fresh install) -> full suite (minus @slow-agent) -> global teardown (uninstall)
npm run test:keep             # same, but retain NEXUS_PATH + VAULT_PATH for inspection
npm run test:only -- <specs>  # same lifecycle, but only the named specs + the required cleanup spec (stage-inbox-exclusion); --keep retains artifacts and skips the cleanup spec
npm run test:pipeline:fast    # tests/pipeline only, excludes @slow-agent
npm run test:pipeline:slow    # tests/pipeline only, @slow-agent tests only
npm run test:unit             # fast unit tests for setup-service.ps1's argument construction (no real install)
npm run report                # open the last HTML report
npm run clean                 # wipe NEXUS_PATH (service uninstall + dir) and VAULT_PATH by hand
npm run lint                  # eslint .
```

`npm run test:unit` runs `tests/helpers/*.test.ts` on Node's built-in test runner (via `tsx`, not Playwright — `.test.ts` is deliberately a different suffix from `.spec.ts` so Playwright's `testMatch` never picks it up). It mocks `execFileSync` to assert the exact `git`/`setup-service.ps1` arguments and stdin `clearInstall`/`installFresh` send — including the elevation check and the `.env.local` sanity check — without cloning, installing a service, or requiring an elevated shell.

`scripts/clean.ts` does not run automatically — use it to reset the machine by hand between manual runs.

### Test Lifecycle

`npm test` drives the full lifecycle through Playwright's own `globalSetup`/`globalTeardown` hooks (wired in `playwright.config.ts`), both plain TypeScript:

1. **`tests/global-setup.ts`** — clears any dirty/leftover install (uninstalls the service if present, removes `NEXUS_PATH`), clones `NexusCampaigns` fresh, then runs `setup-service.ps1 -CleanInstall`. `setup-service.ps1` itself is the target repo's own installer, so it's shelled out to as a subprocess. Afterwards, warns (doesn't fail the run) if no `.env.local` file exists anywhere under `NEXUS_PATH` — `-CleanInstall` wipes them and nothing recreates them, a suspected cause of silent vision-agent failures.
2. **the spec suite** — runs in full, against the freshly installed dashboard/daemon and `VAULT_PATH`.
3. **`tests/global-teardown.ts`** — uninstalls the service and wipes `NEXUS_PATH`/`VAULT_PATH` (same steps as `scripts/clean.ts`), leaving `.testing` clean for the next run. Run `npm run test:keep` to skip this step.

Global setup/teardown run on every `playwright test` invocation (including filtered runs, e.g. `npx playwright test image-processing`).

`clearInstall`/`installFresh` (global-setup, global-teardown, `clean.ts`) all take a lock file at `.testing/.install.lock` — whichever runs first wins, the other two throw immediately instead of racing the same install dir. Stale lock (killed process) → delete the file by hand.

### Test Catalog

`npm test` runs everything under `tests/` (minus `@slow-agent`). `npm run test:pipeline:fast`/`test:pipeline:slow` only cover `tests/pipeline/` — `tests/image-tags/*`, `tests/token.spec.ts`, `tests/bestiary-classification.spec.ts`, and `tests/scenario-rename-test.spec.ts` run only via plain `npm test`.

#### Pipeline stages (`tests/pipeline/stage-*.spec.ts`)

- **`stage-setup-agent-config.spec.ts`** — fast, no daemon wait: asserts global-setup's `registry.yaml` interval overrides (`overrideAgentSchedules`) landed in every agent's synthesized `agent.json`.
- **`stage-inbox-ingestion.spec.ts`** — a messy filename (spaces + emoji) is normalized before vision ever sees it; asserts `inbox-queue.json` queued the right agent slots (`wiki: skip`, `vision: done`).
- **`stage-inbox-exclusion.spec.ts`** — the only spec that actually deletes anything: hands its own paths to the shared cleanup ledger, drains it (picking up every other spec's registered paths too), and asserts they're gone from disk. Positioned right after `stage-inbox-ingestion`.
- **`stage-library-promotion.spec.ts`** — simulates the human review step (`promoteToLibrary`, since agents are blocked from doing this themselves) approving a draft into `02-Library`; asserts approved frontmatter and that the dashboard reflects it.
- **`stage-archive.spec.ts`** — promotes then retires a note (`archiveNote`) into `99-Archive`; asserts `status: archived` frontmatter survives a re-read.

#### Agents (`tests/pipeline/agent-*.spec.ts`)

- **`agent-classification-enrichment.spec.ts`** — classification-agent (LocalRouter `localhost:8080`) enriches a vision draft's tags/type; asserts an `ok` `processed-images.json` entry.
- **`agent-lore-npc-generation.spec.ts`** — a portrait/body drop + an active scenario (`withScenarioActive`) produces an NPC draft; asserts `processed-npcs.json`.
- **`agent-thumbnail-generation.spec.ts`** `@slow-agent` — asserts a cached `system/state/thumbs/<sha1>.webp` thumbnail appears.
- **`agent-token-generation.spec.ts`** — a portrait/body drop gets a sibling `{stem}-token.png` circular token image.
- **`agent-wiki-compilation.spec.ts`** — wiki-agent compiles a dropped `00-Inbox/docs/*.md` document into a Processing draft (images never reach this agent — ingestion always queues them `wiki: skip`).
- **`agent-wikilink-related-links.spec.ts`** `@slow-agent` — two same-tag Library notes (`orc1.jpg`/`orc2.jpg`) get cross-referenced in each other's `## Related` section.
- **`agent-review-report.spec.ts`** — review-agent injects `suggestedQuality` into a `quality: 0` draft and refreshes that day's `report-<date>.json`.
- **`agent-repair-maintenance.spec.ts`** `@slow-agent` — waits out a full ~25min repair cycle and asserts `repair-<date>.json` refreshes. Content-agnostic maintenance; ties up a worker for up to ~1h.
- **`agent-cleanup-log-purge.spec.ts`** `@slow-agent` — creates its own 91-day-backdated dummy log file and asserts cleanup-agent purges it. Never touches real production logs.

#### Whole pipeline (`tests/pipeline/`)

- **`image-processing.spec.ts`** — the original full-pipeline spec via a plain filesystem drop: `sword-test.jpg` → renamed + drafted, with frontmatter, body-section (`## Description`, `## Related`), and dashboard-match assertions. Slow — a live backlog can push this out 50+ minutes.
- **`inbox-upload.spec.ts`** — fast, UI-only: proves the two `/gm/inbox` upload entry points (Upload button, drag-and-drop) land the file and show up in the inbox listing. Does **not** wait for the vision daemon — the full round-trip is already covered once by `image-processing.spec.ts`.

#### Image tags (`tests/image-tags/*.spec.ts`)

One spec per fixture image, all sharing the same shape (drop under a random name → wait for the vision draft → assert `id`/structural invariants/tags). Tags beyond `tags[0]` are frequently filename-guessed, not verified ground truth — see the `ponytail:` comments in each file.

| Fixture | Expected tags |
|---|---|
| `bow.jpg` | token, bow, weapon |
| `city-battlemap.jpg` | battlemap, city |
| `dragon-blue.jpg` | body, dragon, blue |
| `dragon-red.jpg` | body, dragon, red |
| `dragon-red-mountains.jpg` | scene, dragon, red, mountains |
| `dragon-white.jpg` | body, dragon, white |
| `eirc-cavalier.jpg` | portrait, cavalier |
| `elf-ranger.jpg` | portrait, elf, ranger |
| `hank-ranger.jpg` | portrait, ranger |
| `heman-barbarian2.jpg` | portrait, barbarian |
| `heman-barbarian3.jpg` | portrait, barbarian |
| `misty-mountains.jpg` | scene, mountains |
| `two-characters-heman-and-she-ra.jpg` | scene, barbarian |
| `two-characters-skeletor-and-Hordakr.jpg` | scene, undead |
| `vingador.jpg` | portrait |

#### Standalone (`tests/`)

- **`token.spec.ts`** — one test per portrait/body image-tag fixture (9 total); each drops its own fixture, waits for the vision draft, then asserts a sibling `{stem}-token.png` gets generated. Existence only, no likeness check — see the file's `TODO` for a future face-recognition assertion.
- **`bestiary-classification.spec.ts`** — reference/template for scenario tests: `skeletor.jpg` gets `undead`/`skeleton` tags, a bestiary `type` (`creature`/`monster`/`encounter`), and shows up on `/gm/bestiary`.
- **`scenario-rename-test.spec.ts`** — regression guard: the vision-assigned slug must be content-derived and must not equal or contain the random source filename's stem.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Helpers

- `tests/helpers/config.ts` — env-driven paths/timeouts/vault subdirectory constants (`INBOX_IMAGES_DIR`, `INBOX_DOCS_DIR`, `PROCESSING_DIR`, `LIBRARY_DIR`, `ARCHIVE_DIR`). Nothing else lives here.
- `tests/helpers/nexus-install.ts` — clones/installs/uninstalls the Nexus codebase (`clearInstall`, `installFresh`), the cross-process install lock (`withInstallLock`), the elevation check, the `.env.local` sanity check (`warnIfEnvLocalMissing`), and the test-lane schedule rewrite applied to every fresh clone (`overrideAgentSchedules`/`readAgentIntervals`). `BRANCH` is read from `NEXUS_BRANCH` here. Covered by `nexus-install.test.ts` (mocks `execFileSync`, never runs a real install).
- `tests/helpers/vault-utils.ts` — the core polling/assertion toolkit: `snapshotDir`/`diffNewFiles` (the directory-diff baseline pattern every spec uses), `copyFixtureWithRandomName`, `waitForSlugNote` (the primary "did the pipeline run" signal — polls until the dropped image is renamed *and* a draft note's `source:` frontmatter references it), `pollNoteUntil` (re-polls one already-located note for second-stage agent enrichment), `assertDraftInvariants` (structural checks only — UUID/sha256 format, `status`/`quality`/`reviewed` defaults, non-empty `tags`/`source`; never asserts on LLM-generated prose), `assertTagsInclude`, `hasSection`, `copyForInspection`/`copyNexusDiagnostics` (save a failing run's files plus `NEXUS_PATH`'s `automation.log`/state JSON into `tmp/` before cleanup/teardown deletes the originals), and the centralized cleanup registry (`registerCreatedPaths`/`drainCreatedPathsRegistry`/`cleanupCreatedFiles`) — specs hand their created paths to a shared on-disk ledger instead of deleting them in their own `afterAll`; only `stage-inbox-exclusion.spec.ts` drains it.
- `tests/helpers/nexus-state.ts` — direct access to the daemon's own JSON state files under `NEXUS_PATH` that `vault-utils.ts` can't reach from vault files alone: state-file path constants (`INBOX_QUEUE_PATH`, `PROCESSED_IMAGES_PATH`, `PROCESSED_NPCS_PATH`, `SCENARIOS_PATH`, `WIKILINK_STATE_PATH`, `REPORTS_DIR`, `THUMBS_DIR`, `DAEMON_LOGS_DIR`), `readJsonState`/`pollJsonState` (mirrors `pollNoteUntil`'s shape for raw JSON state), `findEntryByFilename`, `promoteToLibrary`/`archiveNote` (simulate the human review/retirement steps agents are blocked from doing themselves), `withScenarioActive` (temporarily flips a scenario's `active` flag, restores the original in a `finally`), `computeSha1`, and `createStaleLogFixture` (its own 91-day-backdated dummy log for the cleanup-agent test — never touches real logs).
- `tests/helpers/dashboard-ui.ts` — dashboard page interactions: `openNoteByUuid`/`assertNoteMatchesFrontmatter` (open a note, assert its type/status `<select>`s, tag chips, and source line match frontmatter), `uploadViaButton`/`uploadViaDragAndDrop`.
- `tests/helpers/profile.ts` — whole-run resource profiling: `startSampler`/`stopSampler` (a detached CPU/memory sampler process spanning install → every test → uninstall), `marker` (phase boundaries written by global-setup/teardown and `scripts/profile-reporter.ts`), `summarize`/`buildReport` (joins samples + markers into `tmp/profile/resource-report.html`, also copied into the Playwright HTML report as `resource-usage.html`). Covered by `profile.test.ts`.

### Adding a New Image/Scenario Test

Follow `tests/bestiary-classification.spec.ts` as the template. Structure:

1. Add the fixture image to `tests/fixtures/test-images/`.
2. `test.describe.serial(...)` with a `createdPaths: string[]`, baselines snapshotted in `beforeAll` via `snapshotDir(INBOX_IMAGES_DIR)` / `snapshotDir(PROCESSING_DIR)`.
3. Step 1 — drop the fixture: `copyFixtureWithRandomName('your-image.jpg')`, push `destPath` onto `createdPaths`.
4. Step 2 — wait for the vision draft: `waitForSlugNote(randomName, inboxBaseline, processingBaseline)`, push `notePath`/`imagePath`, then `assertDraftInvariants(data, noteId)` for the structural checks every draft must pass.
5. Step 3 (if your scenario needs second-stage enrichment — tags beyond the image category, or a refined `type`) — `pollNoteUntil(notePath, predicate, describe, { timeout })`. Give it a real ceiling below the 10min test timeout (3min is the going rate) so a stuck/offline agent fails fast with a readable message instead of eating the whole budget silently.
6. Assert your scenario's expectations: exact tags via `toContain`, `type` against the relevant vocab (e.g. `BESTIARY_TYPES`), dashboard visibility via `page.goto('/gm/<pillar>')` + `page.getByText(noteId)`.
7. `test.afterEach(async ({}, testInfo) => { if (testInfo.status !== testInfo.expectedStatus) { const dir = await copyForInspection(createdPaths, testInfo.title); await copyNexusDiagnostics(dir); } })` — copies whatever the run created, plus `NEXUS_PATH`'s daemon log/state JSON, into `tmp/<timestamp>_<test-title>/` for manual review *before* `afterAll`/global teardown deletes the originals. Always add this for a new scenario test; a failed classification/tagging assertion (or a timeout) is exactly the case you want the artifacts for.
8. `afterAll` → `registerCreatedPaths(createdPaths)` — hand the paths to the centralized cleanup ledger; `stage-inbox-exclusion.spec.ts` drains and deletes them.

### Keeping Test Data After a Full Run

`npm run test:keep` skips `global-teardown.ts`'s uninstall/wipe step entirely, leaving `NEXUS_PATH` and `VAULT_PATH` in place for inspection. The test runner consumes `--keep` and sets `NEXUS_TEST_KEEP` for `tests/global-setup.ts` and `tests/global-teardown.ts`, so npm does not treat it as an unknown configuration option and Playwright does not receive it as an unsupported CLI argument. `npm test -- --keep` remains available when you need to combine the flag with other Playwright options. Setup logs `[global-setup] --keep set, ...` at the start of the run so it's visible on the console immediately, not just at teardown. `scripts/clean.ts` still does a full wipe regardless, so run `npm run clean` by hand when you're done inspecting.

`global-teardown.ts` normally only wipes the ephemeral Nexus install (`NEXUS_PATH`) and vault (`VAULT_PATH`) — it never touches Playwright's own output. So a full run already leaves the useful stuff on disk afterward even without `--keep`:

- `playwright-report/` — the HTML report (`npm run report` to open it).
- `test-results/` — traces/videos/screenshots for failing tests (`trace`/`video`: `retain-on-failure`, `screenshot`: `only-on-failure` in `playwright.config.ts`).
- `tmp/<timestamp>_<test-title>/` — a failing spec's own created files plus `NEXUS_PATH`'s `automation.log`/state JSON, copied there by `copyForInspection`/`copyNexusDiagnostics` in `afterEach`, *before* teardown deletes the originals.
- `tmp/profile/resource-report.html` — the whole-run CPU/memory profile (`tests/helpers/profile.ts`), also embedded in the HTML report as `resource-usage.html`.

None of the above is cleared by `npm test` or `npm run clean` — only re-running the suite (which overwrites `playwright-report/`/`test-results/`) or deleting `tmp/` by hand clears it.

### Notes / Gotchas

- 3 workers, `fullyParallel: false` — spec *files* run in parallel, tests *within* a file stay in written order (`describe.serial`). Accepted risk: concurrent specs share one real vault, so `waitForSlugNote`'s baseline-diff can in theory cross-match another spec's renamed file if two drops land close together. No retries.
- Cleanup deletes only the specific files a run created — never folders, to avoid OneDrive Cloud-Files placeholder issues.
- `expect.timeout` is 15s by default (fails fast on a bad selector); only the long polls (`waitForSlugNote`, `pollNoteUntil`) get the extended budget explicitly.
- Classification-agent enrichment depends on LocalRouter (`localhost:8080`) being up — if it's offline the agent logs a WARN and skips, and a `pollNoteUntil` waiting on tags/type will time out. That's a real signal, not flakiness — check `nexus/agents/runtime/state/logs/automation.log` for `LocalRouter offline`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [ ] Face-recognition assertion for generated tokens (`tests/token.spec.ts` currently asserts existence only — see its `TODO`)
- [ ] LLM-backend preflight in `global-setup` (check LM Studio `/v1/models` before burning a full run on an offline vision agent)
- [ ] Verify remaining `ponytail:`-marked tag expectations and state-file schemas against live daemon runs
- [ ] Parallelize `@slow-agent` tests (bottleneck is the daemon's `pipeline_mode:sync` scheduler, not Playwright worker count)

See the [open issues](https://github.com/rodrigoazlima/nexus-testing/issues) for the full list.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are welcome. Fork the repo, create a feature branch (`git checkout -b feature/my-test`), commit, push, and open a pull request.

Hard rules for this repo (see `AGENTS.md`):

- Never mock the daemon, vault, or dashboard. If a step can't be verified live, say so — don't fake it.
- Never `rm -rf` a vault folder. Only delete files a test itself created, via the centralized registry (`registerCreatedPaths` → `stage-inbox-exclusion.spec.ts`). The vault is OneDrive-backed; folder deletes risk Cloud-Files placeholder corruption.
- Never assert on LLM-generated prose (note body text, descriptions). Structural invariants only.
- Don't add a way to force-trigger the vision/classification/other agents — that's out of scope (the Nexus codebase itself). Tests wait out the real interval.
- Never delete approved Library content — archive it instead (`archiveNote` moves to `99-Archive`, doesn't delete).
- Never touch `.testing/.install.lock` by hand except to clear a stale lock from a killed process.

Run `npm run lint` and `npm run test:unit` before opening a PR.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Rodrigo Lima — [@rodrigoazlima](https://github.com/rodrigoazlima)

Project Link: [https://github.com/rodrigoazlima/nexus-testing](https://github.com/rodrigoazlima/nexus-testing)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [Best-README-Template](https://github.com/othneildrew/Best-README-Template)
* [Playwright](https://playwright.dev/)
* NexusCampaigns — the system under test

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/rodrigoazlima/nexus-testing.svg?style=for-the-badge
[contributors-url]: https://github.com/rodrigoazlima/nexus-testing/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/rodrigoazlima/nexus-testing.svg?style=for-the-badge
[forks-url]: https://github.com/rodrigoazlima/nexus-testing/network/members
[stars-shield]: https://img.shields.io/github/stars/rodrigoazlima/nexus-testing.svg?style=for-the-badge
[stars-url]: https://github.com/rodrigoazlima/nexus-testing/stargazers
[issues-shield]: https://img.shields.io/github/issues/rodrigoazlima/nexus-testing.svg?style=for-the-badge
[issues-url]: https://github.com/rodrigoazlima/nexus-testing/issues
[license-shield]: https://img.shields.io/github/license/rodrigoazlima/nexus-testing.svg?style=for-the-badge
[license-url]: https://github.com/rodrigoazlima/nexus-testing/blob/master/LICENSE
[Playwright-badge]: https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white
[Playwright-url]: https://playwright.dev/
[TypeScript-badge]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Node-badge]: https://img.shields.io/badge/Node.js-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white
[Node-url]: https://nodejs.org/
