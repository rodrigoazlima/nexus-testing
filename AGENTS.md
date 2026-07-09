# AGENTS.md

Playwright black-box tests for Nexus Campaigns image pipeline. Real daemon, real vault, real dashboard — no mocks.

## Run

```
npm test          # global-setup (fresh install) -> specs -> global-teardown (uninstall)
npm run report
npm run clean     # wipe NEXUS_PATH + VAULT_PATH by hand
```

## Hard rules

- Never mock the daemon, vault, or dashboard. If a step can't be verified live, say so — don't fake it.
- Never `rm -rf` a vault folder. Only delete files a test itself created (`cleanupCreatedFiles`). Vault is OneDrive-backed; folder deletes risk Cloud-Files placeholder corruption.
- Never touch `.testing/.install.lock` by hand except to clear a stale lock from a killed process. `clearInstall`/`installFresh` (global-setup, global-teardown, `clean.ts`) take this lock — concurrent callers throw, they don't queue.
- Never assert on LLM-generated prose (note body text, descriptions). Structural invariants only (`assertDraftInvariants`) — the model's wording is not in-scope.
- Don't add a way to force-trigger the vision/classification agents. Out of scope (`C:\Users\rodrigo\nexus`). Tests wait out the real interval (`waitForSlugNote`, `pollNoteUntil`).

## Layout

- `tests/*.spec.ts` — one `describe.serial` block per scenario, template = `tests/bestiary-classification.spec.ts`.
- `tests/helpers/config.ts` — env-driven paths/timeouts, nothing else.
- `tests/helpers/vault-utils.ts` — filesystem polling/diffing/frontmatter.
- `tests/helpers/dashboard-ui.ts` — Playwright page interactions.
- `tests/helpers/nexus-install.ts` — clone/install/uninstall + the install lock.
- `tests/global-setup.ts` / `tests/global-teardown.ts` — Playwright lifecycle hooks, not called from specs.

## Config that matters

- `playwright.config.ts`: `workers: 3`, `fullyParallel: false` — spec files run parallel, tests inside one file stay ordered. Accepted risk: parallel specs share one vault, cross-match is theoretically possible in `waitForSlugNote`.
- `POLL_INTERVAL_MS` (default 5s), `POLL_TIMEOUT_MS` (default 85min), `TEST_TIMEOUT_MS` (default 90min) — env-overridable, see `tests/helpers/config.ts`.
- `expect.timeout` is 15s — only the two poll helpers get the long budget explicitly, on purpose (bad selector should fail in seconds, not 90min).

## Adding a scenario test

Copy `tests/bestiary-classification.spec.ts`. Order: drop fixture → `waitForSlugNote` + `assertDraftInvariants` → optional `pollNoteUntil` for second-stage enrichment (give it a real ceiling, don't inherit the full 90min) → scenario assertions → dashboard visibility check → `afterEach` copy-on-failure (`copyForInspection`) → `afterAll` cleanup (`cleanupCreatedFiles`).
