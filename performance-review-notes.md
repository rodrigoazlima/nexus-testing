# Performance Review — nexus-image-pipeline-tests

**Reviewed by:** QA Analyst / System Architect pairing (Claude Code session)
**Date:** 2026-07-09
**Method:** Live `npm run test` execution (elevated PowerShell, required for `setup-service.ps1`'s Windows service install), full run observed start to finish with a timestamped log, cross-referenced against the repo's own source and `AGENTS.md`/`README.md`.

## Executive summary

The suite took **1h 29m 17s** wall-clock for one `npm test` invocation. Of that:

- **~80 seconds (1.5%)** — global setup: uninstall old service, git clone, run `setup-service.ps1 -CleanInstall`.
- **~13 seconds** — the two fast UI-only tests (`inbox-upload.spec.ts`), both passed.
- **~89 minutes (98.4%)** — the two real-pipeline tests (`image-processing.spec.ts`, `bestiary-classification.spec.ts`) polling for the vision-agent daemon to rename a dropped image. **Both timed out and failed** — neither ever got past step 1 ("wait for the vision daemon to rename the image and write a draft note").

**The suite isn't just slow — on this measured run it was slow *and wrong*.** Two of four tests burned the full ~85-minute poll ceiling and still failed. The dominant cost isn't inherent test overhead; it's the architecture's core bet — waiting out a real, external, non-triggerable daemon on its own schedule — and on this run that bet didn't pay off within budget. See "Suspected root cause" below: there's a plausible, evidence-backed reason the daemon may not have run at all, and the harness destroyed the one log that could confirm it.

## Timing breakdown (measured)

| Phase | Start | End | Duration | % of total |
|---|---|---|---|---|
| Service uninstall (pre-existing install) | 12:37:46 | 12:37:53 | ~7s | <0.1% |
| Remove old codebase dir | 12:37:53 | 12:38:06 | ~13s | 0.2% |
| `git clone` NexusCampaigns | 12:38:06 | 12:38:07 | ~1.4s | <0.1% |
| `setup-service.ps1 -CleanInstall` | 12:38:08 | 12:39:06 | ~58s | 1.1% |
| **Global setup total** | 12:37:46 | 12:39:06 | **~80s** | **1.5%** |
| `inbox-upload` — Upload button test | 12:39:06 | 12:39:15 | 9s | 0.2% |
| `inbox-upload` — drag-and-drop test | 12:39:06 | 12:39:19 | 13s | 0.2% |
| `image-processing` — wait for vision daemon | 12:39:0x | 14:08:23 | **~89 min → TIMEOUT** | 98.4% |
| `bestiary-classification` — wait for vision daemon | 12:39:0x | 14:08:23 | **~89 min → TIMEOUT** | (concurrent with above) |
| Global teardown (uninstall + wipe) | 14:08:23 | ~14:08:2x | few sec | <0.1% |
| **Total** | 12:37:46 | 14:08:23 | **1h 29m 17s** | 100% |

`image-processing` and `bestiary-classification` run concurrently (different spec files, `workers: 3`), so their ~89-minute waits overlap rather than stack — the suite's wall-clock is gated by the *slower* of the two, not their sum. The measured 89m17s vs. the configured `POLL_TIMEOUT_MS` of 85m is consistent — the extra ~4 minutes is hook/teardown overhead (service uninstall, vault removal, reporter flush), not additional polling.

## Why the architecture is *inherently* slow (by design, independent of this run's failure)

This is a deliberate, documented trade-off, not an oversight:

- **No force-trigger exists.** `AGENTS.md` explicitly forbids adding one — the vision/classification agents live in `NexusCampaigns` (out of scope for this repo). The only way to observe pipeline behavior is to wait out the real daemon on its real schedule (`tests/helpers/vault-utils.ts:78-85`).
- **The daemon's own cadence sets the floor.** A 60s runtime loop feeds a documented 900s (15 min) vision-agent interval (`playwright.config.ts:3-8`). A previous live run (2026-07-07, per code comments) needed 3+ backlog cycles (~50 min) before reaching a freshly dropped file, which is why `POLL_TIMEOUT_MS`/`TEST_TIMEOUT_MS` are budgeted at 85/90 minutes.
- **This run had zero backlog** (`queueDepth=0` in the daemon's own startup log, confirmed live) — the vault is wiped and rebuilt empty by every `-CleanInstall`, so the backlog-contention scenario from the code comments does not apply here. That makes the 89-minute *failure* on an empty queue more concerning, not less: there was no backlog excuse this time.
- **Two of four tests are structurally single-purpose full-budget consumers.** Every scenario test (`image-processing`, `bestiary-classification`, and any future one following the documented template) pays the same up-to-85-minute vision-agent wait independently — `bestiary-classification` pays it again even though `image-processing` already proves the same first stage. There's no shared/cached "wait once, branch" fixture; each spec re-waits from scratch.

## Suspected root cause of this run's failure (hypothesis — evidence below, not confirmed)

`setup-service.ps1 -CleanInstall`'s own banner, captured verbatim in the log, states it deletes:

```
- Dashboard node_modules and .next build cache
- All agent state files, indexes, and log files
- All .env.local config files
- 01-Processing drafts (pending review)
- 04-Relationships (auto-generated graphs)
```

**`.env.local` config files are wiped on every clean install**, and the log shows no subsequent step that recreates or seeds them (only `tasks-state.json` and `agent-metrics.json` get "Re-created with defaults"). If `.env.local` is where the vision-agent's LLM/vision API credentials live, a fresh `-CleanInstall` would leave vision-agent unable to authenticate on every single test run — which would produce exactly what was observed: total silence for the full poll window, on an empty queue, with no backlog excuse.

This is a **hypothesis, not a confirmed diagnosis** — and the reason it can't be confirmed is itself a finding (next section): `tests/global-teardown.ts` deletes `NEXUS_PATH` (including `agents/runtime/state/logs/automation.log`) immediately after the run, before anyone can inspect what the daemon actually did during the 89-minute wait. The one snapshot captured live during this review (see Appendix) shows the runtime dispatching `repair-agent`, `review-agent`, and `thumbnails-agent` within the first two seconds of install — but not `vision-agent`, and no later snapshot was taken before teardown destroyed the log.

**Action item, not a code change:** re-run once with `TEST_TIMEOUT_MS`/`POLL_TIMEOUT_MS` shortened (e.g. 5 min) against a throwaway `NEXUS_PATH`, and `tail -f agents/runtime/state/logs/automation.log` live during the run, to confirm or rule this out directly.

## Other findings

1. **Teardown destroys the only diagnostic evidence of a daemon-side failure.** `global-teardown.ts` unconditionally uninstalls the service and `rmSync`s `NEXUS_PATH` — win or lose. On a pass this is correct hygiene. On a *timeout failure* (the expensive, hard-to-reproduce case that most needs a post-mortem), it deletes `automation.log`, agent state, and everything else that would explain *why* the daemon didn't respond, at the exact moment that evidence is most valuable. Playwright's own artifacts (`test-results/*/trace.zip`, `error-context.md`, screenshots, video) only capture the *test's* side (a blank/unchanged dashboard) — none of them can show what the daemon was doing.
2. **`thumbnails-agent` errors on every fresh install.** Confirmed live: `[thumbnails-agent] ERROR: cannot read inbox queue: [Errno 2] No such file or directory: '...\system\state\inbox-queue.json'`. The runtime dispatches this agent before anything has created `inbox-queue.json` (presumably `ingestion-agent`'s job). This is a real bug in the installed system, out of scope to fix here, but worth flagging upstream — it's not a test artifact, it reproduces on every clean install.
3. **Cross-match risk (documented, but now empirically closer to real).** `README.md` already accepts the risk that concurrent specs sharing one vault can cross-match each other's dropped files in `waitForSlugNote`'s baseline diff. This run's failure log shows exactly that shape: `bestiary-classification`'s error lists `image-processing`'s dropped filename as a "new inbox file," and vice versa (both still-unrenamed originals show up in each other's diff). It didn't cause a false pass here only because neither file was ever renamed — if the daemon *had* processed one of them, the risk of the wrong test claiming the wrong note is real, not theoretical.
4. **Every scenario test re-pays the full vision-agent wait independently**, per the architecture note above — this is the single biggest lever on total suite time as more scenario tests get added (see Recommendations).
5. **Elevation friction.** `setup-service.ps1` requires an elevated shell (Windows service install). Nothing in `README.md`/`AGENTS.md` calls this out — a contributor running `npm test` from a normal terminal gets a failure whose cause (missing admin rights) isn't obvious from the error surface alone.

## Recommendations (prioritized)

**High priority**
- Confirm or rule out the `.env.local` hypothesis directly (see Action item above) — this determines whether the suite is fine and just got unlucky, or whether it *cannot* pass against a truly clean install right now.
- On failure, copy `NEXUS_PATH/agents/runtime/state/logs/automation.log` (and `system/state/*.json`) into the same `tmp/<timestamp>_<test>/` inspection folder that `copyForInspection` already produces for vault files, *before* teardown runs. This is a small, high-value change — it turns "the daemon was silent for 85 minutes, no idea why" into an actual debuggable artifact, and costs nothing on the passing path.
- Document the elevation requirement in `README.md` setup steps.

**Medium priority**
- Consider whether `bestiary-classification.spec.ts` (and future scenario tests) can branch off a *shared* vision-daemon wait within one test run (drop both fixtures up front, wait once for whichever completes, then branch per-scenario) rather than each paying its own up-to-85-minute cost independently. This is the only lever that scales as more scenario tests are added — right now, N scenario tests cost roughly `max(one full vision wait)` in the *best* concurrent case but `N × up-to-85min` in the worst case if the daemon serializes work across dropped files (plausible, since it's one real daemon processing one queue).
- Add a cheap daemon-liveness pre-check to `global-setup.ts` (e.g., confirm `vision-agent` has completed at least one dispatch cycle since install, à la the `repair-agent`'s own "Overdue" bookkeeping) so a dead/misconfigured daemon fails fast at setup instead of silently burning 85 minutes per scenario test.

**Low priority / already well-handled**
- `expect.timeout: 15s` vs. the long-poll opt-in via explicit `timeout` — already correctly scoped (a bad selector fails in seconds, not 90 minutes). No change needed.
- Install lock (`withInstallLock`) already prevents the concurrent-install race. No change needed.

## Appendix — daemon startup snapshot (captured live, ~12:38:15, before teardown deleted the log)

```
[repair-agent] WARN: Overdue: vision-agent last_run=1783611496s ago (threshold=1800s)
[repair-agent] WARN: Dashboard port 48080 not listening: [WinError 10061] ...
[repair-agent] INFO: --- DONE (repairs: 5, failed: 0, elapsed: 3.16s) ---
[runtime] INFO: Dispatching review-agent (review agent) [due]
[review-agent] INFO: Vault health: pendingReview=0 orphans=0 libraryLinkViolations=0 queueDepth=0 queuePending=0 queueDone=0
[runtime] INFO: Dispatching thumbnails-agent (...) [due]
[thumbnails-agent] ERROR: cannot read inbox queue: [Errno 2] No such file or directory: '...\system\state\inbox-queue.json'
[runtime] WARN: Task thumbnails-agent exited with code 1 — skipping git commit
```

No `vision-agent` dispatch was observed in this window — its 1800s (30 min) overdue threshold means the runtime loop wouldn't be expected to dispatch it for up to 30 minutes after install, one plausible innocent explanation independent of the `.env.local` hypothesis above. This is exactly the kind of question the deleted `automation.log` could have answered definitively.
