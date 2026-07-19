# QA Feedback: vision-agent never processes the queue — 26 of 29 test failures trace to one cause

**Reported by:** full suite run, 2026-07-19 (`npm test`, 114 tests, 29 failed)
**Symptom:** Every spec that waits on `waitForSlugNote` (vision agent renaming a dropped image + writing a `01-Processing/*.md` draft) timed out at 10 minutes with `Original still in inbox: true`. This is not 26 separate defects — it is one root cause surfacing through every test that depends on the vision pipeline.

This document only analyzes — no code was changed while producing it.

---

## Root Cause

### 1. (Primary) `vision-agent` dispatch is sandboxed, and no container runtime exists on PATH

`agents/registry.yaml:184-186`:

```yaml
sandbox:
  enabled: true
  allow_deletes: false
```

Only `vision` has `sandbox.enabled: true` — `lore`, `classification`, and `wiki` all have it `false` (`registry.yaml:203-205, 220-222, 238-240`). `Runtime.dispatch()` (`system/src/nexus/runtime/scheduler.py:76-77`) checks this flag first and, when set, routes the whole task through `nexus.tasks.sandbox_run` instead of the normal `cli`/`claude-api` runner path:

```python
if dispatch_config.agent_is_sandboxed(agent_name) and not dispatch_config.running_inside_sandbox():
    return self._dispatch_sandboxed(agent_name, task_id)
```

`sandbox_run.run()` immediately calls `_detect_runtime()` (`system/src/nexus/tasks/sandbox_run.py:92-100`):

```python
def _detect_runtime(preferred: Optional[str]) -> str:
    candidates = [preferred] if preferred else ["podman", "docker"]
    for name in candidates:
        if name and shutil.which(name):
            return name
    raise SandboxPreflightError(
        "No container runtime found on PATH (checked: podman, docker). "
        "Install Podman or Docker to use nexus.tasks.sandbox_run."
    )
```

This machine has neither on PATH. Every vision-agent cycle in the run's `automation.log` shows the same failure, immediately, with zero images processed:

```
[2026-07-19 14:25:04] [vision-agent] ERROR: Sandboxed dispatch failed: No container runtime found on PATH (checked: podman, docker). Install Podman or Docker to use nexus.tasks.sandbox_run.
[2026-07-19 14:25:04] [vision-agent] INFO: --- DONE (processed: 0, failed: 1, elapsed: 0.0s) ---
```

Since vision never writes a draft, `waitForSlugNote` (`tests/helpers/vault-utils.ts:151-250`) never finds a new `01-Processing/*.md` referencing the dropped image and eventually times out at the full `POLL_TIMEOUT_MS` (10 min) for every affected spec — 26 of the 29 failures in this run share this exact error shape (`tests/pipeline/image-processing.spec.ts`, every `tests/image-tags/*.spec.ts`, `bestiary-classification.spec.ts`, `scenario-rename-test.spec.ts`, `pipeline/agent-lore-npc-generation.spec.ts`, `pipeline/stage-*.spec.ts`, etc.).

### 2. (Secondary, independent) A sandboxed agent's `fallback_dispatch` is unreachable — dead code today

`Runtime.dispatch()` (`scheduler.py:68-125`) only consults `entry.fallback_dispatch` in the *non*-sandboxed branch:

```python
if exit_code != 0 and entry.fallback_dispatch is not None:
    log.info(f"Primary failed (exit {exit_code}) - trying fallback dispatch ({entry.fallback_dispatch.type})")
    ...
```

But for a sandboxed agent, the function returns at line 77 — `return self._dispatch_sandboxed(agent_name, task_id)` — before this block is ever reached. `_dispatch_sandboxed()` itself (`scheduler.py:127-148`) has no equivalent fallback attempt; on any exception (including `SandboxPreflightError`) it just logs and returns `exit_code=1`:

```python
try:
    from nexus.tasks import sandbox_run
    exit_code = sandbox_run.run(agent_name)
except Exception as exc:
    log.error(f"Sandboxed dispatch failed: {exc}")
    exit_code = 1
```

So even if `vision`'s `agent.json` declared a `fallback_dispatch` (e.g., "if the sandbox can't run, fall back to a direct `cli`/`classify_images.py` invocation"), it would never fire — `fallback_dispatch` is silently dead for any agent with `sandbox.enabled: true`. This means today there is no way for a sandboxed agent to degrade gracefully when the container runtime is unavailable; it simply fails every cycle, forever, with no operator-facing signal beyond the automation.log line.

---

## Steps to Reproduce

1. On a machine with neither `podman` nor `docker` on `PATH`, run `npm test` (or any single spec that waits on `waitForSlugNote`, e.g. `npx playwright test tests/pipeline/image-processing.spec.ts`).
2. Drop any fixture image — ingestion renames it into the inbox correctly, but vision-agent never picks it up.
3. Tail `.testing/nexus/agents/runtime/state/logs/automation.log` (or the copied diagnostics under `tmp/<timestamp>_<test>/automation.log` after a failed run) and observe the `Sandboxed dispatch failed: No container runtime found on PATH` line repeating every cycle.
4. Confirm `agents/registry.yaml`'s `agents.vision.sandbox.enabled` is `true` while `lore`/`classification`/`wiki` are `false` — vision is the only agent gated behind a container runtime.

---

## Proposed Solution

### For issue #1 — environment/infra, not a Nexus code bug
Install Podman or Docker on any machine that runs this test suite (or any machine expected to run the daemon with `vision.sandbox.enabled: true`), and add it to the documented prerequisites (`CLAUDE.md` / `.env.example`) alongside the existing LM Studio / Qwen3-VL requirement. Recommend a cheap preflight check in `global-setup.ts` (mirroring the existing `warnIfEnvLocalMissing` non-fatal warning pattern) that runs `shutil.which`-equivalent detection for `podman`/`docker` before the suite starts, so a missing runtime fails fast with a clear message instead of burning a full 10-minute timeout per spec.

### For issue #2 — Nexus codebase change (`system/src/nexus/runtime/scheduler.py`), flagging for the Nexus maintainer
Give `_dispatch_sandboxed()` the same fallback opportunity the normal path has: on a non-zero `exit_code` (or a caught exception), check `entry.fallback_dispatch` and retry through the normal `get_runner()` path exactly as `dispatch()`'s own fallback block already does, rather than duplicating that logic — e.g. by having `_dispatch_sandboxed` return its exit code back into the same fallback check instead of returning directly. This is a product decision (does a sandboxed agent get a non-sandboxed fallback at all, or is sandbox failure meant to hard-fail by design?) — raised here as an observation, not prescribed.
