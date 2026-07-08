# nexus-image-pipeline-tests

Black-box Playwright tests for the Nexus Campaigns image ingestion pipeline: dropping/uploading an image into the vault's `00-Inbox/images`, waiting for the real vision-agent daemon to rename it and write an enriched draft note into `01-Processing`, and checking both the vault filesystem and the dashboard UI reflect that result.

These tests exercise the **real** daemon (out of scope, lives at `NEXUS_PATH`) and a **real** vault (`VAULT_PATH`). No mocks, no fixtures/teardown isolation between runs.

## Setup

```
npm install
cp .env.example .env   # then edit as needed
```

Env vars (see `tests/helpers/config.ts`):

| Var | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./.testing/vault` | root of the Obsidian vault under test |
| `DASHBOARD_URL` | `http://localhost:48080` | dashboard base URL (Playwright `baseURL`) |
| `POLL_TIMEOUT_MS` | `85 * 60_000` (85 min) | how long to poll the vault for the daemon's output |
| `POLL_INTERVAL_MS` | `15_000` | poll interval while waiting |
| `TEST_TIMEOUT_MS` | `90 * 60_000` (90 min) | Playwright per-test timeout |
| `NEXUS_PATH` | `./.testing/nexus` | Nexus codebase/service install used by `tests/global-setup.ts` / `tests/global-teardown.ts` (not read by the specs themselves). Must be NTFS — `setup-service.ps1` links agents via junctions, unsupported on exFAT. |

## Running

```
npm test          # global setup (fresh install) -> full suite -> global teardown (uninstall)
npm run report    # open the last HTML report
```

`npm test` drives the full lifecycle through Playwright's own `globalSetup`/`globalTeardown` hooks (wired in `playwright.config.ts`), both plain TypeScript:

1. **`tests/global-setup.ts`** — clears any dirty/leftover install (uninstalls the service if present, removes `NEXUS_PATH`), clones `NexusCampaigns` fresh, then runs `setup-service.ps1 -CleanInstall`. Same steps as `custom-install.ps1`, kept as our own TS copy rather than invoking that script directly. `setup-service.ps1` itself is the target repo's own installer, so it's still shelled out to as a subprocess.
2. **the spec suite** — runs in full, against the freshly installed dashboard/daemon and `VAULT_PATH`.
3. **`tests/global-teardown.ts`** — uninstalls the service, leaving the machine clean for the next run.

Global setup/teardown run on every `playwright test` invocation (including filtered runs, e.g. `npx playwright test image-processing`).

```
npm run clean     # wipe NEXUS_PATH (service uninstall + dir) and VAULT_PATH
```

`scripts/clean.ts` does not run automatically — use it to reset the machine by hand between manual runs.

## Tests

- **`tests/image-processing.spec.ts`** — full pipeline: copies `fixtures/test-images/sword-test.jpg` into `00-Inbox/images` under a random name, polls (no way to force-trigger the daemon — a 60s runtime loop feeding a 900s vision-agent interval) until it's renamed and a draft note appears in `01-Processing`, then asserts frontmatter invariants, body sections, and that the dashboard's note view matches. Slow — a live backlog can push this out 50+ minutes.
- **`tests/inbox-upload.spec.ts`** — fast, UI-only: proves the two `/gm/inbox` upload entry points (Upload button, drag-and-drop) land the file in `00-Inbox/images` and show up in the inbox listing. Does **not** wait for the vision daemon — the full round-trip is already covered once by `image-processing.spec.ts`.

## Helpers

- `tests/helpers/config.ts` — env-driven paths/timeouts.
- `tests/helpers/vault-utils.ts` — directory snapshotting/diffing, frontmatter parsing (`gray-matter`), `waitForSlugNote` (polls for the daemon's renamed image + draft note), `assertDraftInvariants` (structural checks only — never asserts on LLM-generated prose), cleanup of files created during a run.
- `tests/helpers/dashboard-ui.ts` — dashboard page interactions: open a note by UUID, assert note view matches frontmatter, upload via button, upload via drag-and-drop.

## Notes / gotchas

- Tests run serial, single worker, no retries — they share one real vault and must not race each other over the same inbox/processing folders.
- `afterAll` hooks delete only the specific files a run created (`cleanupCreatedFiles`) — never folders, to avoid OneDrive Cloud-Files placeholder issues.
- `expect.timeout` is 15s by default (fails fast on a bad selector); only `waitForSlugNote`'s own `.toPass()` gets the long poll budget explicitly.
