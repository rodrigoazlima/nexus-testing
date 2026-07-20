# Handoff: vision-agent sandbox reliability — what's done, what's actually left, and a scope trap to avoid

**Written:** 2026-07-20, handing off mid-session after a stuck automation kept demanding out-of-scope work.

---

## Read this first if you were told to "fix code on `.testing/nexus`"

Don't. `.testing/nexus` (or `NEXUS_PATH` generally) is a **throwaway clone**, wiped and re-cloned fresh by `clearInstall()`/`installFresh()` (`tests/helpers/nexus-install.ts`) on every `npm test`, `npm run clean`, or global-setup run. Any edit made there survives only until the next install cycle — it is not a place to land a real fix.

This repo (`nexus-testing`) is black-box tests *for* the Nexus daemon, not the daemon itself. AGENTS.md is explicit: daemon-code changes are out of scope for this repo. If the actual Nexus source needs a fix, that means editing the real Nexus repo (`NEXUS_REPO_URL`/`NEXUS_BRANCH` in `.env`, cloned locally elsewhere — e.g. `C:\Users\rodrigo\nexus` — as its own git working copy), not the ephemeral test-lane install under this repo's `.testing/`.

A prior session got stuck for ~15 turns on a repeating "Stop hook feedback" message insisting on `.testing/nexus` modification specifically. It was declined every time for the reason above, and its source was never located (checked: project `.claude/settings.json` — doesn't exist; user `~/.claude/settings.json` — no `Stop` hooks; enterprise `managed-settings.json` — not found; `CronList` — empty). If you hit the same message, same answer applies. If you have visibility into where it's coming from, that's worth resolving, but it doesn't change what's in scope for this repo.

---

## What this session actually fixed (all in `nexus-testing`, all in scope)

Triggered by a live log showing `Sandboxed dispatch failed: podman info failed (exit 125): Cannot connect to Podman` — vision-agent dispatch is sandboxed and hard-requires a container runtime (see `03-vision-agent-sandbox-runtime-missing.md`). Three real issues found via new unit tests, all fixed:

1. **`tests/helpers/nexus-install.ts`** — added `assertSandboxRuntimeAvailable()`: checks `podman info`/`docker info` (not just PATH presence), retries 3x with 1s backoff (a machine mid-boot flaps from unreachable to reachable within seconds — a single-shot check false-negatives on pure timing). Wired into `tests/global-setup.ts` as the first thing that runs, before clone/install, so a dead runtime fails in <1s instead of 26 specs each burning the full 10min `POLL_TIMEOUT_MS`.
2. **`tests/helpers/vault-image-utils.ts`** — `waitForSlugNote`'s source-matching used `src.endsWith(candidate)`. An unrelated new inbox file whose name is a *suffix* of the real renamed sibling (e.g. `orc.jpg` vs `zzz-orc.jpg`) false-matched, then got permanently discarded by the inode-disambiguation check instead of the matcher trying the real candidate — a genuine false-negative that would time out a passing run. Fixed to exact `path.basename(src) === candidate`. Verified by temporarily reverting the fix and confirming the new test (`matches the real sibling even when an unrelated new file is a name-suffix of it`) fails against the old code, then re-confirming green after restoring it.
3. **Same file** — the mid-write `catch { continue }` around `readFrontmatter()` swallowed parse errors completely silently. A genuinely corrupt note looked identical to "not written yet" for the full timeout. Now logs `"<note>" not readable yet (mid-write?): <error>"`.

Also from earlier in the session: `AGENT_INTERVAL_VISION_S` test-lane override added (`nexus-install.ts`, default 90s — was previously falling through to the generic 300s default), and every stale "900s vision-agent interval" doc comment corrected across `CLAUDE.md`, spec files, and helper comments.

75/75 unit tests pass (`npm run test:unit`), lint clean (`npm run lint`). Nothing has been committed — all changes are working-tree only as of this handoff.

---

## What's genuinely still open (real Nexus-repo work, not this repo)

From `03-vision-agent-sandbox-runtime-missing.md`, issue #2, never implemented (analysis-only, correctly flagged for the Nexus maintainer, not attempted here):

**`system/src/nexus/runtime/scheduler.py`** — `Runtime.dispatch()` gives non-sandboxed agents a fallback path on failure (`entry.fallback_dispatch`, checked after a non-zero exit code), but `_dispatch_sandboxed()` (lines ~127-148 as of the 2026-07-19 clone) has no equivalent: on any exception it just logs and returns `exit_code=1`, so a sandboxed agent (today, only `vision`) can never degrade gracefully when the container runtime is unavailable — it fails every cycle, forever, no matter what `fallback_dispatch` says in its `agent.json`.

Proposed direction (from 03, not prescribed as final): after `_dispatch_sandboxed()`'s exit code comes back non-zero, route through the same `entry.fallback_dispatch` check `dispatch()`'s non-sandboxed branch already does, instead of returning directly. This is a product decision for whoever owns that repo (does a sandboxed agent get a non-sandboxed fallback at all, or is sandbox failure meant to hard-fail by design?) — flag it, don't just land a fix unilaterally.

To pick this up: clone/open the actual Nexus repo (not `.testing/nexus`), make the change there, and go through whatever that repo's own review process is. This repo's job stops at "tests tolerate the daemon's real behavior and preflight-check what they can" — which is now done for the sandbox-runtime-missing case.
